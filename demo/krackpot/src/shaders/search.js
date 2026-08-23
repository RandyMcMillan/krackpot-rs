// Search shader. The hot path:
//   per-thread starting point = base_pub + (gid * keys_per_thread) * G
//   then iterate +G per key, hash, compare against target PKH.
//
// `base_pub` is the affine pubkey for the chunk's starting privkey, computed on
// the CPU via the JS reference (one scalar mul per chunk, amortized).
// `G` and `base_pub` are passed as affine; mixed-add does the rest.
//
// Output: atomic counter + small fixed-size hit array. On hit, the thread does
// atomicAdd(&count) and writes (gid.x, key_offset) at that index. CPU resolves
// the actual privkey as chunk_start + gid.x * keys_per_thread + key_offset.

import { secp256k1WGSL } from "./secp256k1.js";
import { sha256WGSL } from "./sha256.js";
import { ripemd160WGSL } from "./ripemd160.js";

export const searchWGSL = secp256k1WGSL + sha256WGSL + ripemd160WGSL + /* wgsl */ `

struct ThreadOffset {
  x: U256,
  y: U256,
};

const OFFSET_TABLE_BITS: u32 = 22u;

struct SearchParams {
  base_x: U256,
  base_y: U256,
  target_pkh: array<u32, 5>,
  keys_per_thread: u32,
  // offset_table[k] = (2^k * keys_per_thread) * G in affine form. CPU writes once at setup.
  offset_table: array<ThreadOffset, OFFSET_TABLE_BITS>,
};

struct FoundKey {
  thread_id: u32,
  key_offset: u32,
};

struct SearchOutput {
  found_count: atomic<u32>,
  results: array<FoundKey, 16>,
};

@group(0) @binding(0) var<storage, read>       params: SearchParams;
@group(0) @binding(1) var<storage, read_write> result: SearchOutput;

fn pubkey_to_sha_input(x: U256, prefix: u32) -> array<u32, 14> {
  var w: array<u32, 14>;
  w[0] = (prefix << 24u) | ((x.limbs[7] >> 8u) & 0x00FFFFFFu);
  for (var i: u32 = 1u; i < 8u; i = i + 1u) {
    let hi   = (x.limbs[8u - i] & 0xFFu) << 24u;
    let lo24 = (x.limbs[7u - i] >> 8u) & 0x00FFFFFFu;
    w[i] = hi | lo24;
  }
  w[8] = (x.limbs[0] & 0xFFu) << 24u;
  for (var i: u32 = 9u; i < 14u; i = i + 1u) { w[i] = 0u; }
  return w;
}

fn bswap32(x: u32) -> u32 {
  let a = (x >> 24u) & 0x000000FFu;
  let b = (x >> 8u)  & 0x0000FF00u;
  let c = (x << 8u)  & 0x00FF0000u;
  let d = (x << 24u) & 0xFF000000u;
  return a | b | c | d;
}

fn pkh_eq(pkh: array<u32, 5>, tgt: array<u32, 5>) -> bool {
  var diff: u32 = 0u;
  for (var i: u32 = 0u; i < 5u; i = i + 1u) {
    diff = diff | (pkh[i] ^ tgt[i]);
  }
  return diff == 0u;
}

// Per-thread keys-per-batch cap. Stored arrays are sized to MAX_BATCH; if the
// runtime keys_per_thread param is smaller, only the first S slots are used.
// Safari's WGSL compiler caps function-scope variables at 8 KB.
// 4 × 48 × 32 = 6144 bytes for the arrays leaves headroom for the rest.
const MAX_BATCH: u32 = 48u;

// Hash a Jacobian point given a precomputed Z⁻¹.
fn hash_with_zinv(x: U256, y: U256, z_inv: U256) -> array<u32, 5> {
  let z_inv_sq = fp_sqr(z_inv);
  let z_inv_cu = fp_mul(z_inv_sq, z_inv);
  let x_aff = fp_mul(x, z_inv_sq);
  let y_aff = fp_mul(y, z_inv_cu);
  let prefix = select(0x02u, 0x03u, (y_aff.limbs[0] & 1u) == 1u);
  let sha_words = pubkey_to_sha_input(x_aff, prefix);
  let sha = sha256_short(sha_words, 33u);
  var rm_in: array<u32, 14>;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) { rm_in[i] = bswap32(sha[i]); }
  for (var i: u32 = 8u; i < 14u; i = i + 1u) { rm_in[i] = 0u; }
  return ripemd160_short(rm_in, 32u);
}

@compute @workgroup_size(64)
fn search(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  let raw_S = params.keys_per_thread;
  let S = min(raw_S, MAX_BATCH);
  if (S == 0u) { return; }

  // Per-thread starting point: walk the bits of t, summing precomputed multiples
  // (2^k * S) * G from the CPU-uploaded table, then add base_pub (affine).
  // For set bit b of t, offset_table[b] = (2^b * S) * G in affine form, so
  // sum over set bits gives t * S * G.
  var R = point_infinity();
  for (var b: u32 = 0u; b < OFFSET_TABLE_BITS; b = b + 1u) {
    if (((t >> b) & 1u) == 1u) {
      R = point_add_mixed(R, params.offset_table[b].x, params.offset_table[b].y);
    }
  }
  R = point_add_mixed(R, params.base_x, params.base_y);

  let GX = U256(GX_LIMBS);
  let GY = U256(GY_LIMBS);

  // Walk S Jacobian points, storing X, Y, Z. Z's get batch-inverted next.
  var Xs: array<U256, MAX_BATCH>;
  var Ys: array<U256, MAX_BATCH>;
  var Zs: array<U256, MAX_BATCH>;
  Xs[0] = R.x; Ys[0] = R.y; Zs[0] = R.z;
  for (var k: u32 = 1u; k < S; k = k + 1u) {
    R = point_add_mixed(R, GX, GY);
    Xs[k] = R.x; Ys[k] = R.y; Zs[k] = R.z;
  }

  // Montgomery's trick: invert all S Z's with ONE Fermat inverse + ~3(S-1) muls.
  // INV[k] is reused: first as the prefix product Z[0]*…*Z[k], then as Z[k]^-1.
  var INV: array<U256, MAX_BATCH>;
  INV[0] = Zs[0];
  for (var k: u32 = 1u; k < S; k = k + 1u) {
    INV[k] = fp_mul(INV[k - 1u], Zs[k]);
  }
  var u = fp_inv(INV[S - 1u]);
  // Walk back: at iteration k, INV[k-1] still holds the prefix product P[k-1].
  for (var k: u32 = S; k > 1u; k = k - 1u) {
    let kk = k - 1u;
    let tmp = fp_mul(u, INV[kk - 1u]);
    u = fp_mul(u, Zs[kk]);
    INV[kk] = tmp;
  }
  INV[0] = u;

  // Now hash each affine pubkey and compare against target.
  for (var k: u32 = 0u; k < S; k = k + 1u) {
    let pkh = hash_with_zinv(Xs[k], Ys[k], INV[k]);
    if (pkh_eq(pkh, params.target_pkh)) {
      let idx = atomicAdd(&result.found_count, 1u);
      if (idx < 16u) {
        result.results[idx].thread_id = t;
        result.results[idx].key_offset = k;
      }
    }
  }
}
`;
