// Browser-side test runner. Each test produces a row in the test results table.

import { runComputeOnce, bigIntToLimbBytes, limbBytesToBigInt, currentGpuPhase } from "./webgpu.js";
import { testBigintWGSL } from "./shaders/test_bigint.js";
import { testSha256WGSL } from "./shaders/test_sha256.js";
import { testRipemd160WGSL } from "./shaders/test_ripemd160.js";
import { testSecp256k1WGSL } from "./shaders/test_secp256k1.js";
import { testPipelineWGSL } from "./shaders/test_pipeline.js";
import { searchWGSL } from "./shaders/search.js";
import { ripemd160 } from "./reference/ripemd160.js";
import { P, Gx, Gy, scalarMul } from "./reference/secp.js";
import { privToPkh } from "./reference/address.js";
import { encodeP2PKH } from "./reference/base58.js";

const MASK_256 = (1n << 256n) - 1n;

// Per-test cap, budgeted PER PHASE rather than as one flat wall-clock number.
//
// The flat 25s cap was refusing capable GPUs, and the reason it went unnoticed for so long is
// that its rationale sounds airtight: "a device that needs >25s for one test is hopeless for the
// search anyway". That is true of EXECUTION and false of COMPILATION. A one-time cold shader
// compile says nothing about steady-state keys/sec.
//
// @Rolo_Gee, 2026-08-20, RX 7800 XT on Windows, a card this table measures at 125.6 MK/s: all
// three browsers timed out at 25s on SEARCH smoke #1 on the first attempt, then Brave PASSED
// after two reloads and Firefox got past #1. Reloading cannot fix a wrong shader, incapable
// hardware, or a data-dependent infinite loop, because all three are deterministic. Monotonic
// progress across reloads means something persists between page loads and warms up, and that is
// the driver's on-disk shader cache.
//
// Which makes the timeout the PROXIMATE CAUSE of the refusal, in a loop the app inflicts on
// itself: the compile exceeds 25s, we give up and refuse, but a WebGPU compile CANNOT BE
// CANCELLED, so the driver finishes it anyway and caches the result, and the next load gets
// further on the work we threw away. Users who happened to reload got in; users who trusted the
// refusal did not.
//
// The decisive consequence is that WAITING IS FREE. We pay for that compile whether we wait for
// it or not, so a longer budget costs nothing in the failure case and converts these refusals
// into passes.
const TEST_TIMEOUT_MS = 25000;
// A cold compile is driver-dependent and one-time. Brave needed two 25s attempts plus a third to
// pass, putting this driver's cold compile near 50-75s in one uninterrupted go.
//
// 180s rather than the 120s first written, on an external review's argument that 120 was thin.
// The number matters most for CHROME, which unlike Brave and Firefox never progressed across
// reloads at all, so its cold compile may be considerably slower than the 50-75s the others
// showed, and it is the browser most visitors use. The cost of being generous is small and
// bounded: waiting is free for a device that will pass, Cancel is live throughout, and fail-fast
// means at most ONE test per run can reach this budget.
const COMPILE_BUDGET_MS = 180000;
// Belt and braces, and note it is the EFFECTIVE bound when several phases are slow: three compile
// phases could each claim 180s, so the ceiling is what refuses such a device at five minutes
// rather than nine. It also covers a pathological test that keeps switching phases and would
// otherwise never trip either budget.
const TEST_CEILING_MS = 300000;
// The phases from src/webgpu.js where a long wait is a slow compiler rather than a stuck GPU.
const COMPILE_PHASES = new Set([
  "createShaderModule", "getCompilationInfo", "createComputePipelineAsync",
]);
// Default SHORT deliberately. An unclassified phase can then only ever over-refuse, which is a
// recoverable annoyance, instead of hanging the page, which is not. Same direction as
// DIAGNOSTIC_PREFIXES defaulting to BLOCKING: the fallback is the stricter rule.
export const budgetForPhase = (phase) =>
  COMPILE_PHASES.has(phase) ? COMPILE_BUDGET_MS : TEST_TIMEOUT_MS;
// How often the watchdog looks at the phase. Fine enough that the reported elapsed time is
// accurate to a fraction of a second, coarse enough to be free.
const WATCHDOG_TICK_MS = 250;

// Deterministic small PRNG for reproducible fuzz inputs.
const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const rand256 = (rng) => {
  let n = 0n;
  for (let i = 0; i < 8; i++) {
    const v = BigInt(Math.floor(rng() * 0x100000000));
    n = (n << 32n) | v;
  }
  return n;
};

const hex = (n) => "0x" + n.toString(16).padStart(64, "0");

const packTwo = (a, b) => {
  const out = new Uint8Array(64);
  out.set(bigIntToLimbBytes(a), 0);
  out.set(bigIntToLimbBytes(b), 32);
  return out;
};

const packOne = (a) => {
  const out = new Uint8Array(64);
  out.set(bigIntToLimbBytes(a), 0);
  return out;
};

const runBigintOp = async (entryPoint, a, b) => {
  const input = b === undefined ? packOne(a) : packTwo(a, b);
  const out = await runComputeOnce({
    shaderCode: testBigintWGSL,
    entryPoint,
    inputBytes: input,
    outputByteLen: 32,
  });
  return limbBytesToBigInt(out);
};

const TESTS = [
  // ---- BigInt: u256_add (truncating, no mod) ----
  {
    name: "u256_add: 0 + 0",
    run: async () => {
      const got = await runBigintOp("test_u256_add", 0n, 0n);
      return { ok: got === 0n, got: hex(got), want: hex(0n) };
    },
  },
  {
    name: "u256_add: small",
    run: async () => {
      const got = await runBigintOp("test_u256_add", 1n, 2n);
      return { ok: got === 3n, got: hex(got), want: hex(3n) };
    },
  },
  {
    name: "u256_add: limb-boundary carry",
    run: async () => {
      const a = 0xFFFFFFFFn; // single limb full
      const b = 1n;
      const got = await runBigintOp("test_u256_add", a, b);
      const want = a + b; // 0x100000000
      return { ok: got === want, got: hex(got), want: hex(want) };
    },
  },
  {
    name: "u256_add: ripple carry across all limbs",
    run: async () => {
      const a = MASK_256 - 1n;
      const b = 1n;
      const got = await runBigintOp("test_u256_add", a, b);
      const want = MASK_256;
      return { ok: got === want, got: hex(got), want: hex(want) };
    },
  },
  {
    name: "u256_add: wrap to zero",
    run: async () => {
      const a = MASK_256;
      const b = 1n;
      const got = await runBigintOp("test_u256_add", a, b);
      const want = 0n; // truncating add discards carry
      return { ok: got === want, got: hex(got), want: hex(want) };
    },
  },

  // ---- BigInt: u256_sub ----
  {
    name: "u256_sub: 5 - 3",
    run: async () => {
      const got = await runBigintOp("test_u256_sub", 5n, 3n);
      return { ok: got === 2n, got: hex(got), want: hex(2n) };
    },
  },
  {
    name: "u256_sub: borrow across all limbs",
    run: async () => {
      const a = 0n;
      const b = 1n;
      const got = await runBigintOp("test_u256_sub", a, b);
      const want = MASK_256; // 0 - 1 = -1 = 2^256 - 1 in two's complement
      return { ok: got === want, got: hex(got), want: hex(want) };
    },
  },

  // ---- Field add / sub (mod p) ----
  {
    name: "fp_add: (p-1) + 1 = 0",
    run: async () => {
      const got = await runBigintOp("test_fp_add", P - 1n, 1n);
      return { ok: got === 0n, got: hex(got), want: hex(0n) };
    },
  },
  {
    name: "fp_add: (p-1) + (p-1) = p-2",
    run: async () => {
      const got = await runBigintOp("test_fp_add", P - 1n, P - 1n);
      return { ok: got === P - 2n, got: hex(got), want: hex(P - 2n) };
    },
  },
  {
    name: "fp_sub: 0 - 1 = p-1",
    run: async () => {
      const got = await runBigintOp("test_fp_sub", 0n, 1n);
      return { ok: got === P - 1n, got: hex(got), want: hex(P - 1n) };
    },
  },

  // ---- Field mul ----
  {
    name: "fp_mul: 1 * 1 = 1",
    run: async () => {
      const got = await runBigintOp("test_fp_mul", 1n, 1n);
      return { ok: got === 1n, got: hex(got), want: hex(1n) };
    },
  },
  {
    name: "fp_mul: (p-1) * (p-1) = 1",
    run: async () => {
      // (p-1)^2 mod p = (p^2 - 2p + 1) mod p = 1
      const got = await runBigintOp("test_fp_mul", P - 1n, P - 1n);
      return { ok: got === 1n, got: hex(got), want: hex(1n) };
    },
  },
  {
    name: "fp_mul: 2 * (p-1)/2 ≡ p-1",
    run: async () => {
      // (p-1)/2 — since p is odd, p-1 is even
      const half = (P - 1n) / 2n;
      const got = await runBigintOp("test_fp_mul", 2n, half);
      const want = (2n * half) % P;
      return { ok: got === want, got: hex(got), want: hex(want) };
    },
  },
  {
    name: "fp_mul fuzz #1 (deterministic)",
    run: async () => {
      const rng = mulberry32(1);
      const a = rand256(rng) % P;
      const b = rand256(rng) % P;
      const got = await runBigintOp("test_fp_mul", a, b);
      const want = (a * b) % P;
      return { ok: got === want, got: hex(got), want: hex(want) };
    },
  },
  {
    name: "fp_mul fuzz #2 (deterministic)",
    run: async () => {
      const rng = mulberry32(42);
      const a = rand256(rng) % P;
      const b = rand256(rng) % P;
      const got = await runBigintOp("test_fp_mul", a, b);
      const want = (a * b) % P;
      return { ok: got === want, got: hex(got), want: hex(want) };
    },
  },
  {
    name: "fp_mul fuzz #3 (operand near p)",
    run: async () => {
      const a = P - 1n;
      const b = P - 12345n;
      const got = await runBigintOp("test_fp_mul", a, b);
      const want = (a * b) % P;
      return { ok: got === want, got: hex(got), want: hex(want) };
    },
  },

  // ---- Field inv ----
  {
    name: "fp_inv: inv(1) = 1",
    run: async () => {
      const got = await runBigintOp("test_fp_inv", 1n, 0n);
      return { ok: got === 1n, got: hex(got), want: hex(1n) };
    },
  },
  {
    name: "fp_inv: inv(2) * 2 = 1",
    run: async () => {
      const inv2 = await runBigintOp("test_fp_inv", 2n, 0n);
      const check = await runBigintOp("test_fp_mul", inv2, 2n);
      return { ok: check === 1n, got: hex(check), want: hex(1n) };
    },
  },
  {
    name: "fp_inv: inv(rand) * rand = 1",
    run: async () => {
      const rng = mulberry32(7);
      const a = (rand256(rng) % (P - 1n)) + 1n;
      const inv = await runBigintOp("test_fp_inv", a, 0n);
      const check = await runBigintOp("test_fp_mul", inv, a);
      return { ok: check === 1n, got: hex(check), want: hex(1n) };
    },
  },

  // ---- SHA-256 (single-block, ≤55 bytes) ----
  ...sha256Tests(),

  // ---- RIPEMD-160 (single-block, ≤55 bytes) ----
  ...ripemd160Tests(),

  // ---- secp256k1 ----
  ...secp256k1Tests(),

  // ---- End-to-end pipeline (the CLAUDE.md hard gate) ----
  ...pipelineTests(),

  // ---- Search shader integration (planted-key smoke test) ----
  ...searchSmokeTests(),
];

function searchSmokeTests() {
  // Build a search-params buffer matching the WGSL SearchParams layout:
  //   header (88): base_x, base_y, target_pkh, keys_per_thread
  //   table (1408): 22 * (X, Y) of (2^k * keys_per_thread) * G
  const TABLE_BITS = 22;
  const PARAMS_SIZE = 88 + TABLE_BITS * 64;
  const packParams = (basePub, targetPkh, keysPerThread) => {
    const buf = new Uint8Array(PARAMS_SIZE);
    buf.set(bigIntToLimbBytes(basePub[0]), 0);
    buf.set(bigIntToLimbBytes(basePub[1]), 32);
    buf.set(targetPkh, 64);
    const dv = new DataView(buf.buffer);
    dv.setUint32(84, keysPerThread, true);
    // Offset table: each entry is (2^k * keysPerThread) * G in affine.
    let multiplier = BigInt(keysPerThread);
    for (let k = 0; k < TABLE_BITS; k++) {
      const point = scalarMul(multiplier);
      buf.set(bigIntToLimbBytes(point[0]), 88 + k * 64);
      buf.set(bigIntToLimbBytes(point[1]), 88 + k * 64 + 32);
      multiplier *= 2n;
    }
    return buf;
  };

  // Search output layout: u32 count + 16 * (u32 thread, u32 offset) = 132 bytes.
  const unpackOut = (out) => {
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const count = dv.getUint32(0, true);
    const hits = [];
    for (let i = 0; i < Math.min(count, 16); i++) {
      hits.push({
        threadId: dv.getUint32(4 + i*8, true),
        keyOffset: dv.getUint32(4 + i*8 + 4, true),
      });
    }
    return { count, hits };
  };

  const runSearch = async ({ basePriv, targetPriv, keysPerThread }) => {
    const basePub = scalarMul(basePriv);
    const targetPkh = await privToPkh(targetPriv);
    const params = packParams(basePub, targetPkh, keysPerThread);
    const out = await runComputeOnce({
      shaderCode: searchWGSL,
      entryPoint: "search",
      inputBytes: params,
      outputByteLen: 132,
      dispatch: [1, 1, 1],   // 1 workgroup of 64 threads
    });
    return unpackOut(out);
  };

  const cases = [
    {
      name: "SEARCH smoke #1: target at offset 0 (priv 7, base 7)",
      basePriv: 7n, targetPriv: 7n, keysPerThread: 4,
      expect: (h) => h.count === 1 && h.hits[0].threadId === 0 && h.hits[0].keyOffset === 0,
    },
    {
      name: "SEARCH smoke #2: target at offset 1 (priv 8, base 7)",
      basePriv: 7n, targetPriv: 8n, keysPerThread: 4,
      expect: (h) => h.count === 1 && h.hits[0].threadId === 0 && h.hits[0].keyOffset === 1,
    },
    {
      name: "SEARCH smoke #3: target across thread boundary (priv 11, base 7, S=4)",
      basePriv: 7n, targetPriv: 11n, keysPerThread: 4,
      expect: (h) => h.count === 1 && h.hits[0].threadId === 1 && h.hits[0].keyOffset === 0,
    },
    {
      name: "SEARCH smoke #4: target far in dispatch (priv 234, base 100, S=4)",
      basePriv: 100n, targetPriv: 234n, keysPerThread: 4,
      // offset = 134 = 33*4 + 2  ->  thread 33, keyOffset 2
      expect: (h) => h.count === 1 && h.hits[0].threadId === 33 && h.hits[0].keyOffset === 2,
    },
    {
      name: "SEARCH smoke #5: no hit (target outside dispatch range)",
      basePriv: 7n, targetPriv: 999_999n, keysPerThread: 4,
      expect: (h) => h.count === 0,
    },
    {
      name: "SEARCH smoke #6: large privkey base (puzzle-shaped)",
      basePriv: 0x40000000000000000n, targetPriv: 0x40000000000000005n, keysPerThread: 4,
      // offset 5 -> thread 1, keyOffset 1
      expect: (h) => h.count === 1 && h.hits[0].threadId === 1 && h.hits[0].keyOffset === 1,
    },
  ];

  return cases.map((c) => ({
    name: c.name,
    run: async () => {
      const got = await runSearch(c);
      const ok = c.expect(got);
      const desc = got.count === 0 ? "no-hit" : `${got.count} hit(s): ${got.hits.map(h => `t${h.threadId}+${h.keyOffset}`).join(", ")}`;
      return { ok, got: desc, want: "(per-test predicate)" };
    },
  }));
}

function pipelineTests() {
  const unpackPkh = (out) => {
    const pkh = new Uint8Array(20);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (let i = 0; i < 5; i++) {
      const w = dv.getUint32(i * 4, true);
      pkh[i * 4]     =  w        & 0xFF;
      pkh[i * 4 + 1] = (w >>> 8) & 0xFF;
      pkh[i * 4 + 2] = (w >>> 16) & 0xFF;
      pkh[i * 4 + 3] = (w >>> 24) & 0xFF;
    }
    return pkh;
  };

  const runPipeline = async (entry, k) => {
    const out = await runComputeOnce({
      shaderCode: testPipelineWGSL,
      entryPoint: entry,
      inputBytes: bigIntToLimbBytes(k),
      outputByteLen: 20,
    });
    return unpackPkh(out);
  };

  const eqBytes = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

  return [
    {
      name: "PIPELINE Test 1 (privkey 1 → 1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH)",
      run: async () => {
        const got = await runPipeline("test_pk_to_pkh", 1n);
        const want = await privToPkh(1n);
        const ok = eqBytes(got, want);
        const addr = ok ? await encodeP2PKH(got) : "(pkh mismatch)";
        return { ok: ok && addr === "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
                 got: addr, want: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH" };
      },
    },
    {
      name: "PIPELINE Test 2 (privkey 3 → 1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb)",
      run: async () => {
        const got = await runPipeline("test_pk_to_pkh", 3n);
        const want = await privToPkh(3n);
        const ok = eqBytes(got, want);
        const addr = ok ? await encodeP2PKH(got) : "(pkh mismatch)";
        return { ok: ok && addr === "1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb",
                 got: addr, want: "1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb" };
      },
    },
    {
      name: "PIPELINE Test 3 (priv 1 + G via mixed-add → 1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP)",
      run: async () => {
        const got = await runPipeline("test_pk_plus_g_to_pkh", 1n);
        const want = await privToPkh(2n);
        const ok = eqBytes(got, want);
        const addr = ok ? await encodeP2PKH(got) : "(pkh mismatch)";
        return { ok: ok && addr === "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP",
                 got: addr, want: "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP" };
      },
    },
    {
      name: "PIPELINE: pseudo-random privkey, full pipeline matches CPU reference",
      run: async () => {
        const k = 0xDEADBEEFCAFEBABE0123456789ABCDEF112233445566778899AABBCCDDEEFF00n;
        const got = await runPipeline("test_pk_to_pkh", k);
        const want = await privToPkh(k);
        const ok = eqBytes(got, want);
        return { ok, got: toHex(got), want: toHex(want) };
      },
    },
  ];
}

function secp256k1Tests() {
  // Input is a u256 scalar in 32 LE-limb bytes; output is X (32) + Y (32) + is_inf (4) = 68 bytes.
  const runSec = async (entryPoint, k) => {
    const out = await runComputeOnce({
      shaderCode: testSecp256k1WGSL,
      entryPoint,
      inputBytes: bigIntToLimbBytes(k),
      outputByteLen: 68,
    });
    const x = limbBytesToBigInt(out, 0);
    const y = limbBytesToBigInt(out, 32);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const isInf = dv.getUint32(64, true);
    return { x, y, isInf: isInf !== 0 };
  };

  const eqPoint = (got, want) => {
    if (want === null) return got.isInf;
    if (got.isInf) return false;
    return got.x === want[0] && got.y === want[1];
  };

  const fmtPoint = (p) => p === null ? "infinity" : `(${p[0].toString(16).slice(0, 12)}…, ${p[1].toString(16).slice(0, 12)}…)`;
  const fmtGot = (g) => g.isInf ? "infinity" : `(${g.x.toString(16).slice(0, 12)}…, ${g.y.toString(16).slice(0, 12)}…)`;

  const cases = [
    { name: "scalar_mul_g: 1*G",   entry: "test_scalar_mul_g", k: 1n,        ref: () => [Gx, Gy] },
    { name: "scalar_mul_g: 2*G",   entry: "test_scalar_mul_g", k: 2n,        ref: () => scalarMul(2n) },
    { name: "scalar_mul_g: 3*G",   entry: "test_scalar_mul_g", k: 3n,        ref: () => scalarMul(3n) },
    { name: "scalar_mul_g: 0xDEADBEEF*G", entry: "test_scalar_mul_g", k: 0xDEADBEEFn, ref: () => scalarMul(0xDEADBEEFn) },
    { name: "scalar_mul_g: large random k", entry: "test_scalar_mul_g",
      k: 0x123456789ABCDEF0FEDCBA987654321001020304050607080910111213141516n,
      ref: () => scalarMul(0x123456789ABCDEF0FEDCBA987654321001020304050607080910111213141516n) },
    // point_double: doubling 1*G = 2*G
    { name: "point_double: 2*G via doubling 1*G", entry: "test_double_kG", k: 1n, ref: () => scalarMul(2n) },
    { name: "point_double: 6*G via doubling 3*G", entry: "test_double_kG", k: 3n, ref: () => scalarMul(6n) },
    // mixed-add hot path: kG + G == (k+1)G
    { name: "point_add_mixed: 1*G + G == 2*G", entry: "test_kG_plus_G", k: 1n, ref: () => scalarMul(2n) },
    { name: "point_add_mixed: 0xDEADBEEF*G + G == 0xDEADBEF0*G", entry: "test_kG_plus_G",
      k: 0xDEADBEEFn, ref: () => scalarMul(0xDEADBEF0n) },
    { name: "point_add_mixed: (large k)*G + G == (large k +1)*G", entry: "test_kG_plus_G",
      k: 0x0AAAA0BBBB0CCCC0DDDD0EEEE0FFFF000111122223333444455556666777788n,
      ref: () => scalarMul(0x0AAAA0BBBB0CCCC0DDDD0EEEE0FFFF000111122223333444455556666777789n) },
  ];

  return cases.map(({ name, entry, k, ref }) => ({
    name,
    run: async () => {
      const want = ref();
      const got  = await runSec(entry, k);
      const ok = eqPoint(got, want);
      return {
        ok,
        got: fmtGot(got),
        want: fmtPoint(want),
      };
    },
  }));
}

function ripemd160Tests() {
  // RIPEMD-160 input is LE-packed (opposite of SHA-256).
  const packRmInput = (bytes) => {
    if (bytes.length > 55) throw new Error("RIPEMD-160 test only handles ≤55 bytes");
    const buf = new ArrayBuffer(60);
    const dv = new DataView(buf);
    dv.setUint32(0, bytes.length, true);
    for (let i = 0; i < 14; i++) {
      let w = 0;
      for (let j = 0; j < 4; j++) {
        const idx = i * 4 + j;
        const b = idx < bytes.length ? bytes[idx] : 0;
        w |= b << (j * 8);
      }
      dv.setUint32(4 + i * 4, w >>> 0, true);
    }
    return new Uint8Array(buf);
  };

  // Output: 5 LE u32s; each emits 4 bytes low-to-high.
  const unpackRmOutput = (out) => {
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const result = new Uint8Array(20);
    for (let i = 0; i < 5; i++) {
      const w = dv.getUint32(i * 4, true);
      result[i * 4]     =  w        & 0xFF;
      result[i * 4 + 1] = (w >>> 8) & 0xFF;
      result[i * 4 + 2] = (w >>> 16) & 0xFF;
      result[i * 4 + 3] = (w >>> 24) & 0xFF;
    }
    return result;
  };

  const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

  const runRm = async (bytes) => {
    const out = await runComputeOnce({
      shaderCode: testRipemd160WGSL,
      entryPoint: "test_ripemd160",
      inputBytes: packRmInput(bytes),
      outputByteLen: 20,
    });
    return toHex(unpackRmOutput(out));
  };

  const ref = (bytes) => toHex(ripemd160(bytes));

  const cases = [
    { name: "ripemd160: empty",                bytes: new Uint8Array(0) },
    { name: 'ripemd160: "a"',                  bytes: new TextEncoder().encode("a") },
    { name: 'ripemd160: "abc"',                bytes: new TextEncoder().encode("abc") },
    { name: 'ripemd160: "message digest"',     bytes: new TextEncoder().encode("message digest") },
    { name: "ripemd160: 32 zeros (sha256-out shape)", bytes: new Uint8Array(32) },
    { name: "ripemd160: 32 random bytes (sha256-out shape)", bytes: (() => {
        const b = new Uint8Array(32);
        const rng = mulberry32(303);
        for (let i = 0; i < 32; i++) b[i] = Math.floor(rng() * 256);
        return b;
      })() },
    { name: "ripemd160: 55 bytes (max single-block)", bytes: (() => {
        const b = new Uint8Array(55);
        for (let i = 0; i < 55; i++) b[i] = i;
        return b;
      })() },
  ];

  return cases.map(({ name, bytes }) => ({
    name,
    run: async () => {
      const want = ref(bytes);
      const got  = await runRm(bytes);
      return { ok: got === want, got, want };
    },
  }));
}

function sha256Tests() {
  // Pack input bytes into the WGSL ShaIn layout: u32 byte_len + 14 BE-packed u32 words.
  const packShaInput = (bytes) => {
    if (bytes.length > 55) throw new Error("SHA-256 test only handles ≤55 bytes");
    const buf = new ArrayBuffer(60);
    const dv = new DataView(buf);
    dv.setUint32(0, bytes.length, true);
    for (let i = 0; i < 14; i++) {
      let w = 0;
      for (let j = 0; j < 4; j++) {
        const idx = i * 4 + j;
        const b = idx < bytes.length ? bytes[idx] : 0;
        w |= b << ((3 - j) * 8);
      }
      dv.setUint32(4 + i * 4, w >>> 0, true);
    }
    return new Uint8Array(buf);
  };

  // Output: 8 u32s (LE in storage). Each u32 is a BE-packed group of 4 hash bytes.
  const unpackShaOutput = (out) => {
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const result = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      const w = dv.getUint32(i * 4, true);
      result[i * 4]     = (w >>> 24) & 0xFF;
      result[i * 4 + 1] = (w >>> 16) & 0xFF;
      result[i * 4 + 2] = (w >>> 8)  & 0xFF;
      result[i * 4 + 3] =  w         & 0xFF;
    }
    return result;
  };

  const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

  const runSha = async (bytes) => {
    const out = await runComputeOnce({
      shaderCode: testSha256WGSL,
      entryPoint: "test_sha256",
      inputBytes: packShaInput(bytes),
      outputByteLen: 32,
    });
    return toHex(unpackShaOutput(out));
  };

  const ref = async (bytes) => {
    const buf = await crypto.subtle.digest("SHA-256", bytes);
    return toHex(new Uint8Array(buf));
  };

  const cases = [
    { name: "sha256: empty",                bytes: new Uint8Array(0) },
    { name: 'sha256: "a" (pad_pos=1)',      bytes: new TextEncoder().encode("a") },
    { name: 'sha256: "ab" (pad_pos=2)',     bytes: new TextEncoder().encode("ab") },
    { name: 'sha256: "abc" (pad_pos=3)',    bytes: new TextEncoder().encode("abc") },
    { name: 'sha256: "abcd" (pad_pos=0 in next word)', bytes: new TextEncoder().encode("abcd") },
    { name: "sha256: 33 zeros (pubkey shape)", bytes: new Uint8Array(33) },
    { name: "sha256: 33 random bytes (pseudo-pubkey)", bytes: (() => {
        const b = new Uint8Array(33);
        const rng = mulberry32(101);
        for (let i = 0; i < 33; i++) b[i] = Math.floor(rng() * 256);
        b[0] = 0x02; // compressed pubkey prefix
        return b;
      })() },
    { name: "sha256: 55 bytes (max single-block)", bytes: (() => {
        const b = new Uint8Array(55);
        for (let i = 0; i < 55; i++) b[i] = i;
        return b;
      })() },
  ];

  return cases.map(({ name, bytes }) => ({
    name,
    run: async () => {
      const want = await ref(bytes);
      const got  = await runSha(bytes);
      return { ok: got === want, got, want };
    },
  }));
}

// BLOCKING vs DIAGNOSTIC.
//
// The gate used to require all 47 tests to pass, which refused capable hardware over
// shaders the search never runs. Confirmed twice on desktop: an RX 7800 XT timed out on
// "point_add_mixed: 1*G + G == 2*G" while, in the SAME run, PIPELINE Test 3 had already
// passed doing the identical scalar_mul_g -> point_add_mixed -> jacobian_to_affine sequence
// in a different shader module AND hashed the result to a known address. Same maths, same
// device, strictly more work, no problem. The refusal was ours, not the GPU's.
//
// DIAGNOSTIC = the shader is not on the production path, so its correctness cannot affect a
// search. The kernel calls point_add_mixed plus the hashes and nothing else: scalar_mul_g
// runs on the CPU once per chunk, and point_double is never called at all.
//
// Classified centrally by name prefix rather than a flag on all 47 entries, deliberately:
// one auditable list beats 47 scattered booleans, and the DEFAULT IS BLOCKING, so a new
// test can only ever over-block. Over-blocking is a recoverable annoyance; under-blocking
// would let a miscomputing GPU burn electricity forever. scripts/test-gate-scoping.mjs
// asserts the split stays exactly as intended.
//
// Note what stays blocking: PIPELINE Tests 1-3 are the three test vectors CLAUDE.md mandates
// as the hard gate, and all six SEARCH smoke tests run the real kernel. Scoping does not
// weaken the documented rule, it just stops enforcing things the rule never asked for.
const DIAGNOSTIC_PREFIXES = [
  "scalar_mul_g:",       // GPU version is test-only; production does this on the CPU
  "point_double:",       // never called by the search kernel
  "point_add_mixed:",    // standalone wrapper; the real one is covered by SEARCH + PIPELINE
];
export const isDiagnostic = (name) => DIAGNOSTIC_PREFIXES.some((p) => name.startsWith(p));

// Exported for the Node suite, which cannot import the DOM-bound runner.
export const testManifest = () => TESTS.map((t) => ({ name: t.name, diagnostic: isDiagnostic(t.name) }));

const tbody = () => document.querySelector("#test-results tbody");

const addRow = (name) => {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td>${name}</td><td class="want" data-label="Expected"></td><td class="got" data-label="Got"></td><td class="status status-pending" data-label="Status">…</td>`;
  tbody().appendChild(tr);
  return tr;
};

const ellipsize = (s, n = 30) => (s.length > n ? s.slice(0, n) + "…" : s);

export const runAllTests = async (signal, { includeDiagnostics = true } = {}) => {
  tbody().innerHTML = "";
  // Triage order: run the two known fast-fail points FIRST so an incapable
  // device bails within ~2 tests (fail-fast) instead of after the whole suite:
  //   1. "u256_add: 0 + 0" — the Adreno/Dawn pipeline-compile bug hits here.
  //   2. "SEARCH smoke #1" — exercises the full search shader end-to-end; older
  //      GPUs that crash compiling/running it (e.g. a 2015 MacBook Pro) fail here.
  // Test order is NOT part of the capability fingerprint, so this reordering is
  // free — it doesn't invalidate cached passes.
  //
  // Then ALL BLOCKING TESTS BEFORE ANY DIAGNOSTIC ONE, which fixes a real bug rather than
  // just tidying: ripemd160 and sha256 used to sit AFTER the off-path block, so the RX 7800
  // XT that stopped at test 37 never had its hash implementation verified at all. Ordering
  // blocking-first makes fail-fast structurally unable to skip production coverage.
  //
  // Keeping the heavy SEARCH smoke #1 early was a deliberate call. External review argued for
  // moving it last, on the theory that it wedges the GPU and poisons later tests, but that
  // theory does not survive the code: runComputeOnce awaits mapAsync (src/webgpu.js:213), so
  // the kernel has completed before the test can report a pass. With no correctness argument
  // left, the measured fail-fast win keeps its place.
  const TRIAGE = ["u256_add: 0 + 0", "SEARCH smoke #1"];
  const isTriage = (name) => TRIAGE.some((p) => name.startsWith(p));
  const pool = includeDiagnostics ? TESTS : TESTS.filter((t) => !isDiagnostic(t.name));
  const ordered = [
    ...pool.filter((t) => isTriage(t.name)),
    ...pool.filter((t) => !isTriage(t.name) && !isDiagnostic(t.name)),
    ...pool.filter((t) => !isTriage(t.name) && isDiagnostic(t.name)),
  ];
  const total = ordered.length;
  const bar = document.getElementById("tests-progress-bar");
  const label = document.getElementById("tests-progress-label");
  if (bar) { bar.max = total; bar.value = 0; }
  let pass = 0, fail = 0, blockingFail = 0, aborted = false;
  // Tracked in memory as well as in sessionStorage. The storage copy exists only to survive a
  // hung renderer; for every other outcome the in-memory value is authoritative, and relying on
  // storage alone had already produced a misleading "Last test started: unknown" on a Safari
  // refusal where a test certainly had started.
  let lastStarted = null;
  // The message of the failure that stopped the run, so the refusal panel can show WHY rather
  // than only WHERE. It carries the phase, which is the part three bug reports could not supply.
  let lastFailure = null;
  // One promise that rejects when the user cancels, raced against each test so
  // an in-flight (possibly slow) test doesn't delay regaining control.
  const abortP = signal
    ? new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("__cancelled__")), { once: true }))
    : null;
  abortP?.catch(() => {});
  for (let i = 0; i < ordered.length; i++) {
    if (signal?.aborted) { aborted = true; break; }
    const t = ordered[i];
    // Update the affordance BEFORE the (possibly slow) test, then yield a frame
    // so the bar/label actually paint — otherwise a long WGSL test looks frozen.
    // The SEARCH/PIPELINE tests compile the big kernel and are much slower than
    // the primitives — flag that so the wait reads as work, not a freeze.
    const heavy = /^(SEARCH smoke|PIPELINE)/.test(t.name);
    if (label) {
      label.textContent = heavy
        ? `Test ${i + 1} of ${total} — building the search kernel. This can take a few ` +
          `minutes the first time…`
        : `Test ${i + 1} of ${total}`;
    }
    if (bar) bar.value = i;
    await new Promise((r) => requestAnimationFrame(r));
    if (signal?.aborted) { aborted = true; break; }
    const tr = addRow(t.name);
    const diag = isDiagnostic(t.name);
    // Persist the test we are ABOUT to run. A hung renderer takes the page down with no
    // console and no results table, so this is the only thing that survives to say where it
    // stopped. Added because a reporter's "test 5 of 54" could not be mapped: the suite has
    // been 47 tests for its whole history, so the number was unusable and the name is what
    // we actually needed. sessionStorage, not local, so it dies with the tab.
    lastStarted = t.name;
    try { sessionStorage.setItem("puzzlecrack.lastStartedTest", t.name); } catch { /* storage blocked */ }
    let failed = false;
    let timer;
    const runP = t.run();
    runP.catch(() => {});   // if the timeout wins the race, swallow the late rejection
    // ONE PATH BACK TO A COMPILE AFTER #1, worth knowing before reading a report: a lost device
    // clears the module and pipeline caches (dropCachesIfDeviceChanged in src/webgpu.js), so a
    // later SEARCH smoke test recompiles from cold. Otherwise #2-#6 are guaranteed cache hits,
    // because all six pass the same `searchWGSL` string and the same `search` entry point, and
    // `layout: "auto"` derives the bind group layout from the module rather than from the test's
    // buffers. So a stall at #3 with no device loss reported is execution, not compilation.
    //
    // LIMIT OF ANY TIMER HERE, and it decides which reports this can help. `createShaderModule`
    // is SYNCHRONOUS (src/webgpu.js:265). A driver that does its heavy compile inside that call
    // blocks the main thread, so neither this interval nor the old setTimeout can fire at all,
    // and the page simply wedges. That is @Christo26032394's RTX 4060 with Chrome's
    // RESULT_CODE_HUNG: no TIMEOUT was ever reported, because no timer ran. So this change helps
    // reports where a 25s TIMEOUT actually fired, which means the stall was asynchronous, and it
    // does nothing for a synchronous wedge. `lastStartedTest` in sessionStorage remains the only
    // thing that survives that case.
    //
    // Watchdog rather than a single setTimeout, so the budget can follow the phase. It charges
    // time against the CURRENT phase and resets the clock whenever the phase changes, which
    // matters: a test that compiles for 100s and then stalls in mapAsync must trip mapAsync's
    // short budget rather than inherit whatever the compile left over.
    const timeoutP = new Promise((_, reject) => {
      const startedAt = performance.now();
      let phase = currentGpuPhase();
      let phaseAt = startedAt;
      timer = setInterval(() => {
        const now = performance.now();
        const live = currentGpuPhase();
        if (live !== phase) { phase = live; phaseAt = now; }
        const inPhase = now - phaseAt;
        const budget = budgetForPhase(phase);
        const overall = now - startedAt;
        // A silent three-minute pause reads as a crash, and someone who closes the tab loses the
        // run. Once a compile has been going a few seconds, count up so the wait looks like work.
        // Only for compile phases: a stalled dispatch is not something to reassure anyone about.
        if (label && COMPILE_PHASES.has(phase) && inPhase > 5000)
          label.textContent =
            `Test ${i + 1} of ${total} — building the GPU kernel, ${Math.round(inPhase / 1000)}s. ` +
            `Slow only the first time.`;
        // Name the phase AND the budget it blew. A timeout alone told us nothing useful across
        // four bug reports: "createComputePipelineAsync" and "mapAsync" mean a slow compile and a
        // stuck GPU respectively, and they need opposite fixes. The budget is in the message so a
        // future report says unambiguously whether the wait was the long one or the short one.
        if (inPhase > budget)
          reject(new Error(`timed out after ${Math.round(inPhase / 1000)}s in ${phase} ` +
                           `(budget ${budget / 1000}s)`));
        else if (overall > TEST_CEILING_MS)
          reject(new Error(`timed out after ${Math.round(overall / 1000)}s overall, last phase ` +
                           `${phase} (ceiling ${TEST_CEILING_MS / 1000}s)`));
      }, WATCHDOG_TICK_MS);
    });
    const racers = abortP ? [runP, timeoutP, abortP] : [runP, timeoutP];
    try {
      const result = await Promise.race(racers);
      clearInterval(timer);
      tr.querySelector(".want").textContent = ellipsize(result.want ?? "");
      tr.querySelector(".got").textContent  = ellipsize(result.got  ?? "");
      const cell = tr.querySelector(".status");
      if (result.ok) {
        cell.textContent = "PASS";
        cell.classList.remove("status-pending");
        cell.classList.add("status-pass");
        pass++;
      } else {
        cell.textContent = diag ? "WARN" : "FAIL";
        cell.classList.remove("status-pending");
        cell.classList.add(diag ? "status-info" : "status-fail");
        lastFailure = `wrong answer, got ${result.got ?? "?"} wanted ${result.want ?? "?"}`;
        fail++;
        if (!diag) blockingFail++;
        failed = true;
      }
    } catch (e) {
      clearInterval(timer);
      const cell = tr.querySelector(".status");
      if (e.message === "__cancelled__" || signal?.aborted) {
        cell.textContent = "cancelled";
        cell.classList.remove("status-pending");
        cell.classList.add("status-info");
        aborted = true;
        break;
      }
      const timedOut = /timed out/.test(e.message || "");
      cell.textContent = timedOut ? "TIMEOUT" : "ERROR";
      cell.classList.remove("status-pending");
      cell.classList.add(diag ? "status-info" : "status-fail");
      tr.querySelector(".got").textContent = ellipsize(e.message, 100);  // full error still in console.error below
      lastFailure = e.message;
      console.error(t.name, e);
      fail++;
      if (!diag) blockingFail++;
      failed = true;
    }
    if (bar) bar.value = i + 1;
    // Fail-fast on ANY failure, while only BLOCKING failures affect the verdict.
    //
    // Stopping here used to be scoped to blocking failures, on the reasoning that a diagnostic
    // failure refuses nothing so the run may as well continue. That was over-thought. The
    // ordering above already runs every blocking test BEFORE any diagnostic, so breaking on the
    // first failure of any kind can no longer skip production coverage, which was the actual
    // problem with the old behaviour. Continuing past a diagnostic failure instead bought two
    // costs: up to 10 x 25 s of hanging in the manual run, and a cascade of pipeline creation on
    // a driver that has just demonstrated it is fragile, which is the second reason fail-fast
    // existed in the first place. One failed diagnostic already tells you what you needed to
    // know.
    if (failed) {
      const remaining = total - (i + 1);
      if (label) {
        label.textContent = remaining > 0
          ? `Stopped at test ${i + 1} of ${total} — ${remaining} not run` +
            (diag ? " (an off-path check; the search is unaffected)" : " (a failure blocks the search)")
          : `Failed on test ${i + 1} of ${total}`;
      }
      break;
    }
  }
  if (aborted && label) label.textContent = "Cancelled.";
  else if (label) {
    label.textContent = fail === 0
      ? `${total} of ${total} passed`
      : blockingFail === 0
        ? `${pass} of ${total} passed — ${fail} off-path check${fail === 1 ? "" : "s"} failed, which does not affect the search`
        : `${pass} of ${total} passed`;
  }
  return { pass, fail, blockingFail, diagnosticFail: fail - blockingFail, aborted, lastStarted, lastFailure };
};
