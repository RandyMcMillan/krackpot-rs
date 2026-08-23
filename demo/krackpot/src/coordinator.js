// Search coordinator: per-dispatch random chunk start (CSPRNG), CPU base-pubkey
// computation, dispatch loop with TDR-aware sizing, device-loss recovery,
// localStorage checkpoint of the calibrated dispatch size.

import { getDevice, initWebGPU } from "./webgpu.js";
import { searchWGSL } from "./shaders/search.js";
import { scalarMul, bigIntToLimbsLE } from "./reference/secp.js";
import { privToPkh, privToAddress } from "./reference/address.js";
import { decodeP2PKH } from "./reference/base58.js";

const WORKGROUP_SIZE = 64;                        // matches @workgroup_size in search.js
const MAX_HITS = 16;
const KEYS_PER_THREAD = 48;                       // matches MAX_BATCH in search.js (capped to fit Safari's 8 KB limit)
const OFFSET_TABLE_BITS = 22;                     // matches OFFSET_TABLE_BITS in search.js
const HEADER_BYTES = 32 + 32 + 20 + 4;            // base_x, base_y, target_pkh, keys_per_thread
const TABLE_BYTES  = OFFSET_TABLE_BITS * 64;      // 22 entries × (X + Y) = 1408 bytes
const PARAMS_BYTES = HEADER_BYTES + TABLE_BYTES;
const OUTPUT_BYTES = 4 + MAX_HITS * 8;            // count + 16 * (thread, offset)

// Rolling window for the reported keys/sec. Long enough to smooth out
// dispatch-to-dispatch jitter, short enough that the number tracks reality
// within a few seconds of resuming from a locked screen.
const RATE_WINDOW_MS     = 5000;
const TARGET_DISPATCH_MS = 250;                   // safe distance below the OS TDR ~2s threshold
const MIN_DISPATCH_MS    = 50;
const MAX_DISPATCH_MS    = 500;
const CALIBRATION_KEY    = "puzzlecrack.dispatchKeys";

// Smallest and default per-dispatch sizes. We START at one workgroup's worth so
// the very first dispatch on an uncalibrated device can't blow the OS GPU
// watchdog (TDR) before recalibrate() has a chance to run — critical on slower
// mobile GPUs. recalibrate() then ramps up toward TARGET_DISPATCH_MS. A device
// with a persisted calibration (desktop) keeps its larger value.
const MIN_DISPATCH_KEYS     = WORKGROUP_SIZE;                 // 64 (one thread per lane, one key each)
const DEFAULT_DISPATCH_KEYS = WORKGROUP_SIZE * KEYS_PER_THREAD; // 3072 (one workgroup, full batch)
const MAX_RECOVERY_ATTEMPTS = 4;                             // consecutive device losses before giving up

// Ceiling on the calibration ramp. Raised from 1<<25 on 2026-08-19 because two cards
// were measured PINNED here and therefore under-reporting: an RTX PRO 6000 at 381 MK/s
// (88 ms per dispatch) and an RTX 5090 at 343 (98 ms), both wanting to grow toward the
// 250 ms target and unable to. The tell that the cap was the cause rather than the
// silicon: per 1000 CUDA cores those two read 15.8 and 15.8, BELOW the uncapped RTX 5050
// and 5070 at 16.4 and 16.7. Fastest cards, worst per core, which is what fixed
// per-dispatch overhead looks like. At 1<<26 the PRO 6000 lands near 176 ms.
//
// THE BINDING LIMIT IS OFFSET_TABLE_BITS, NOT u32 AND NOT THE WORKGROUP COUNT, and it
// fails SILENTLY. The shader places thread t at (t * KEYS_PER_THREAD) * G by walking the
// bits of t across offset_table[0..OFFSET_TABLE_BITS-1], so max t must stay under
// 2^OFFSET_TABLE_BITS. Past that the high bits are never read, the thread starts from the
// wrong pubkey and scans the wrong keys, and nothing raises an error.
//   1<<26 -> 21,846 workgroups, max t 1,398,143  = 21 of 22 bits, one spare  <- here
//   1<<27 -> 43,691 workgroups, max t 2,796,223  = 22 bits, no margin
//   1<<28 -> 87,382 workgroups, max t 5,592,447  = breaks the table AND 65,535 workgroups
// Do NOT raise this past 1<<27 without raising OFFSET_TABLE_BITS in lockstep (here and in
// search.js; the table costs 64 bytes per bit, so it is nearly free). Note the workgroup
// limit happens to bind one workgroup earlier than the table does, which is why this went
// unnoticed, but maxComputeWorkgroupsPerDimension is only a spec MINIMUM of 65,535 and
// devices report more, so that validation error cannot be relied on to fire first.
const MAX_KEYS_PER_DISPATCH = 1 << 26;                       // 67,108,864

const cryptoRandomBigInt = (lo, hi) => {
  // Sample uniformly in [lo, hi]. hi-lo+1 must fit in some byte length.
  const range = hi - lo + 1n;
  if (range <= 0n) return lo;
  const bits = range.toString(2).length;
  const bytes = Math.ceil(bits / 8);
  const buf = new Uint8Array(bytes);
  while (true) {
    crypto.getRandomValues(buf);
    let n = 0n;
    for (const b of buf) n = (n << 8n) | BigInt(b);
    // Trim to bit length, reject samples ≥ range to keep the distribution uniform.
    n &= (1n << BigInt(bits)) - 1n;
    if (n < range) return lo + n;
  }
};

const packU256LE = (n) => {
  const limbs = bigIntToLimbsLE(n);
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i*4]     = limbs[i] & 0xFF;
    out[i*4 + 1] = (limbs[i] >>> 8) & 0xFF;
    out[i*4 + 2] = (limbs[i] >>> 16) & 0xFF;
    out[i*4 + 3] = (limbs[i] >>> 24) & 0xFF;
  }
  return out;
};

export class SearchCoordinator {
  constructor() {
    this.device = null;
    this.pipeline = null;
    this.paramsBuf = null;
    this.outputBuf = null;
    this.outputReadBuf = null;
    this.bindGroup = null;
    this.running = false;
    this.totalChecked = 0n;
    this.startTime = 0;
    this.lastReportTime = 0;
    // Rolling window of recent dispatches, for the reported keys/sec. See
    // recordSample()/currentRate(): the rate must describe the last few seconds,
    // NOT the average since Start.
    this.samples = [];
    // Calibrated keys-per-dispatch (loaded from localStorage if present, else conservative default).
    // Clamp the restored value to the same ceiling the ramp obeys. The old bound was
    // `saved < 1e9`, which is 15x the previous cap and 30x this one, so a stored value
    // could bypass the ramp's limit entirely and go straight to a size that overflows
    // the offset table (silent wrong keys) or the workgroup limit. Nothing WRITES such a
    // value today, since both writers are the capped ramp and the shrink path, but a
    // ceiling that only applies to growth is not a ceiling.
    const saved = parseInt(localStorage.getItem(CALIBRATION_KEY) ?? "0", 10);
    this.keysPerDispatch = (saved > 0 && saved <= MAX_KEYS_PER_DISPATCH)
      ? saved
      : DEFAULT_DISPATCH_KEYS;
    this.consecutiveLosses = 0;
    // Offset tables, keyed by stride. See ensureOffsetTable(): the table encodes the
    // per-thread STRIDE, and partition() can change that stride between dispatches, so
    // one table built at setup() is not enough. Cached because the recovery ramp walks
    // back up through a handful of strides and each build costs 22 CPU scalarMuls.
    this.tableCache = new Map();
    // Stride of the table currently sitting in paramsBuf, or null when unknown. MUST be
    // reset whenever paramsBuf is recreated (setup() after a device loss makes a NEW
    // buffer, and a cached "already uploaded" would then skip writing the table at all).
    this.uploadedStride = null;
  }

  async setup() {
    // Acquire the device. If it was never created or was lost — e.g. the
    // off-path diagnostics crashed it during the capability check on a fragile
    // driver — request a fresh one so the search can still run.
    let device;
    try {
      device = getDevice();
    } catch {
      ({ device } = await initWebGPU());
    }
    this.device = device;

    const module = device.createShaderModule({ code: searchWGSL });
    const info = await module.getCompilationInfo();
    for (const m of info.messages) {
      if (m.type === "error") throw new Error(`search shader compile error: ${m.message} at line ${m.lineNum}`);
    }
    this.pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "search" },
    });

    this.paramsBuf = device.createBuffer({
      size: PARAMS_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // paramsBuf is brand new, so whatever table used to be uploaded is gone. Forcing a
    // re-upload on the next dispatch is the whole reason this is tracked: setup() runs
    // again after a device loss, and a stale "already uploaded" would leave the table
    // region zeroed, which the shader would read as the point at infinity.
    this.uploadedStride = null;
    this.outputBuf = device.createBuffer({
      size: OUTPUT_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.outputReadBuf = device.createBuffer({
      size: OUTPUT_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuf } },
        { binding: 1, resource: { buffer: this.outputBuf } },
      ],
    });

    // Note: we do NOT flip `this.running` here. Device loss is handled in the
    // dispatch loop's catch (which can shrink + recover), and flipping running
    // from this async callback would race with an in-progress recovery.
    device.lost.then((info) => {
      console.warn("device lost during search:", info.reason, info.message);
    });
  }

  // Re-acquire the WebGPU device and rebuild the pipeline/buffers after a loss
  // (typically an OS GPU-watchdog TDR). Returns true if the device is usable again.
  async recover() {
    try {
      await initWebGPU();   // re-requests adapter + device, resets the module-level handle
      await this.setup();   // rebuilds pipeline, buffers, offset table, bind group on the new device
      return true;
    } catch (e) {
      console.warn("device recovery failed:", e);
      return false;
    }
  }

  // Record a finished dispatch for the rolling rate window. `t1` is when it
  // ended, `elapsedMs` how long it took, so a sample owns a real time span
  // rather than an instant. Samples that end before the window are dropped.
  recordSample(t1, elapsedMs, keys) {
    this.samples.push({ t0: t1 - elapsedMs, t1, keys });
    const cutoff = t1 - RATE_WINDOW_MS;
    while (this.samples.length > 1 && this.samples[0].t1 < cutoff) this.samples.shift();
  }

  // Keys/sec over the last RATE_WINDOW_MS of ACTUAL dispatch time.
  //
  // Deliberately divides by the summed dispatch durations, not by wall clock.
  // Idle gaps (a locked screen or a backgrounded tab stops requestAnimationFrame,
  // so the loop simply stalls) are therefore excluded instead of being averaged
  // in. The previous implementation divided lifetime keys by wall clock since
  // Start, so hours of a locked screen crushed the figure and it needed roughly
  // the length of the idle period to recover, which read as the GPU slowly
  // warming up when it was actually at full speed the whole time.
  //
  // Returns null until there is a sample, so the UI can keep showing a placeholder.
  currentRate() {
    if (this.samples.length === 0) return null;
    let keys = 0, ms = 0;
    for (const s of this.samples) { keys += s.keys; ms += s.t1 - s.t0; }
    return ms > 0 ? (keys * 1000) / ms : null;
  }

  // offset_table[b] = (2^b * stride) * G in affine, packed for upload.
  //
  // The table encodes the per-thread STRIDE: the shader places thread t at
  // base + (t * stride) * G by summing the entries for the set bits of t. So the stride
  // baked in here MUST equal the keys_per_thread in the header and the stride the CPU
  // reconstructs a hit with. Those three drifting apart is exactly the bug this method
  // exists to make impossible; before 2026-08-19 the table was built once with
  // KEYS_PER_THREAD while partition() was free to hand the shader a smaller value.
  //
  // Cached because a build is 22 CPU scalarMuls (~100ms) and the recovery ramp walks back
  // up through several strides, so an uncached build would run repeatedly on the one path
  // where the device is already struggling.
  buildOffsetTable(stride) {
    const cached = this.tableCache.get(stride);
    if (cached) return cached;
    const bytes = new Uint8Array(TABLE_BYTES);
    let multiplier = BigInt(stride);
    for (let k = 0; k < OFFSET_TABLE_BITS; k++) {
      const point = scalarMul(multiplier);
      bytes.set(packU256LE(point[0]), k * 64);
      bytes.set(packU256LE(point[1]), k * 64 + 32);
      multiplier *= 2n;
    }
    this.tableCache.set(stride, bytes);
    return bytes;
  }

  // Make the table in paramsBuf match `stride`, uploading only when it has to change.
  // Returns the stride now in the buffer, which callers treat as the authority.
  ensureOffsetTable(stride) {
    if (this.uploadedStride !== stride) {
      this.device.queue.writeBuffer(this.paramsBuf, HEADER_BYTES, this.buildOffsetTable(stride));
      this.uploadedStride = stride;
    }
    return this.uploadedStride;
  }

  // Run one dispatch. Returns { hits: [...], elapsedMs, stride }.
  async runDispatch({ basePriv, basePubAffine, targetPkh, dispatchWorkgroups, keysPerThread }) {
    const device = this.device;

    // Align the table with this dispatch's stride. Deliberately before t0: a cold build
    // is ~100ms of CPU work, and inside the timed section it would read as a slow
    // dispatch, making recalibrate() shrink. On the recovery path that is a feedback loop
    // straight into the 64-key floor.
    const stride = this.ensureOffsetTable(keysPerThread);

    // Pack the per-dispatch header.
    const header = new Uint8Array(HEADER_BYTES);
    header.set(packU256LE(basePubAffine[0]), 0);    // base_x
    header.set(packU256LE(basePubAffine[1]), 32);   // base_y
    const dv = new DataView(header.buffer);
    for (let i = 0; i < 5; i++) {
      const w = (targetPkh[i*4] | (targetPkh[i*4+1] << 8) | (targetPkh[i*4+2] << 16) | (targetPkh[i*4+3] << 24)) >>> 0;
      dv.setUint32(64 + i*4, w, true);
    }
    dv.setUint32(84, keysPerThread, true);
    device.queue.writeBuffer(this.paramsBuf, 0, header);

    // Clear output buffer (zero out the atomic counter and result slots).
    device.queue.writeBuffer(this.outputBuf, 0, new Uint8Array(OUTPUT_BYTES));

    const t0 = performance.now();
    const cmd = device.createCommandEncoder();
    const pass = cmd.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(dispatchWorkgroups, 1, 1);
    pass.end();
    cmd.copyBufferToBuffer(this.outputBuf, 0, this.outputReadBuf, 0, OUTPUT_BYTES);
    device.queue.submit([cmd.finish()]);

    await this.outputReadBuf.mapAsync(GPUMapMode.READ);
    const out = new Uint8Array(this.outputReadBuf.getMappedRange().slice(0));
    this.outputReadBuf.unmap();
    const elapsedMs = performance.now() - t0;

    const odv = new DataView(out.buffer);
    const count = odv.getUint32(0, true);
    const hits = [];
    for (let i = 0; i < Math.min(count, MAX_HITS); i++) {
      hits.push({
        threadId:  odv.getUint32(4 + i*8, true),
        keyOffset: odv.getUint32(4 + i*8 + 4, true),
      });
    }
    return { hits, elapsedMs, stride };
  }

  // Adjust keysPerDispatch toward the TARGET_DISPATCH_MS sweet spot.
  // Halve immediately on overshoot (the next dispatch could be the one that hits TDR).
  recalibrate(elapsedMs) {
    let next = this.keysPerDispatch;
    if (elapsedMs > MAX_DISPATCH_MS) {
      next = Math.max(WORKGROUP_SIZE, Math.floor(next / 2));
    } else if (elapsedMs < MIN_DISPATCH_MS) {
      next = Math.min(MAX_KEYS_PER_DISPATCH, next * 2);
    } else if (elapsedMs < TARGET_DISPATCH_MS * 0.7) {
      next = Math.min(MAX_KEYS_PER_DISPATCH, Math.floor(next * 1.25));
    }
    if (next !== this.keysPerDispatch) {
      this.keysPerDispatch = next;
      localStorage.setItem(CALIBRATION_KEY, String(next));
    }
  }

  // Compute a (workgroups, keysPerThread) split that produces approximately
  // `desired` keys per dispatch. Constraints:
  //   - keysPerThread >= 1
  //   - workgroups * WORKGROUP_SIZE * keysPerThread >= desired
  //   - keep workgroups * WORKGROUP_SIZE under 2^OFFSET_TABLE_BITS, which is the real
  //     ceiling (see MAX_KEYS_PER_DISPATCH). The old comment here named u32 as the
  //     constraint; u32 is ~64x away and was never the thing that binds.
  partition(desired) {
    let keysPerThread = KEYS_PER_THREAD;
    let workgroups = Math.max(1, Math.ceil(desired / (WORKGROUP_SIZE * keysPerThread)));
    // For a single-workgroup dispatch (the small end, incl. watchdog recovery),
    // also shrink keys-per-thread so the per-thread wall-time can drop below the
    // OS watchdog. Costs batch-inversion efficiency, but a completed small
    // dispatch beats a device-killing large one.
    if (workgroups === 1) {
      keysPerThread = Math.max(1, Math.min(KEYS_PER_THREAD, Math.ceil(desired / WORKGROUP_SIZE)));
    }
    return { workgroups, keysPerThread };
  }

  async start(opts) {
    if (this.running) return;
    this.running = true;
    this.totalChecked = 0n;
    this.consecutiveLosses = 0;
    this.samples = [];
    this.startTime = performance.now();
    this.lastReportTime = this.startTime;

    const targetPkh = await decodeP2PKH(opts.targetAddress);
    const targetPkhArr = Array.from(targetPkh);

    const onHit = async (priv) => {
      const addr = await privToAddress(priv);
      const ok = addr === opts.targetAddress;
      opts.onHit({ priv, addr, verified: ok });
      this.running = false;
    };

    while (this.running) {
      const rangeSize = opts.rangeEnd - opts.rangeStart + 1n;
      const dispatchSize = BigInt(this.keysPerDispatch);
      let chunkPriv;
      if (rangeSize <= dispatchSize) {
        // The entire range fits in one dispatch — sweep from the start.
        chunkPriv = opts.rangeStart;
      } else {
        // Sample chunk_start in [rangeStart - dispatchSize + 1, rangeEnd] so
        // every key in [rangeStart, rangeEnd] has equal probability of falling
        // inside any dispatch — including keys near the low edge. Negative
        // chunk_start values are fine: scalarMul reduces mod N internally, and
        // hits whose recovered priv lands outside the range are filtered below.
        const lo = opts.rangeStart - dispatchSize + 1n;
        const hi = opts.rangeEnd;
        chunkPriv = cryptoRandomBigInt(lo, hi);
      }
      if (chunkPriv === 0n) chunkPriv = 1n;  // scalarMul(0) is the point at infinity
      let basePubAffine;
      try {
        basePubAffine = scalarMul(chunkPriv);  // CPU JS reference (handles negative & wraps mod N)
        if (basePubAffine === null) continue;
      } catch (e) {
        console.warn("CPU scalarMul failed for chunk:", e);
        continue;
      }

      const { workgroups, keysPerThread } = this.partition(this.keysPerDispatch);
      const totalKeysThisDispatch = workgroups * WORKGROUP_SIZE * keysPerThread;

      let hits, elapsedMs, stride;
      try {
        ({ hits, elapsedMs, stride } = await this.runDispatch({
          basePriv: chunkPriv,
          basePubAffine,
          targetPkh: targetPkhArr,
          dispatchWorkgroups: workgroups,
          keysPerThread,
        }));
        this.consecutiveLosses = 0;   // a completed dispatch clears the recovery counter
      } catch (e) {
        // Almost always the OS GPU watchdog (TDR) killing an over-long dispatch.
        // Shrink hard and PERSIST so we converge instead of re-crashing on the
        // same size, then try to re-acquire the device and continue — no manual
        // reload. Give up only after repeated losses (a GPU that can't run even
        // a minimal dispatch within its watchdog window).
        console.warn("dispatch failed (likely device lost / TDR):", e);
        this.consecutiveLosses += 1;
        const shrunk = Math.max(MIN_DISPATCH_KEYS, Math.floor(this.keysPerDispatch / 8));
        this.keysPerDispatch = shrunk;
        localStorage.setItem(CALIBRATION_KEY, String(shrunk));

        if (this.consecutiveLosses > MAX_RECOVERY_ATTEMPTS) {
          this.running = false;
          opts.onDeviceLost?.({ recovered: false, keysPerDispatch: shrunk });
          return;
        }
        opts.onDeviceLost?.({ recovering: true, keysPerDispatch: shrunk, attempt: this.consecutiveLosses });
        const ok = await this.recover();
        if (!ok) {
          this.running = false;
          opts.onDeviceLost?.({ recovered: false, keysPerDispatch: shrunk });
          return;
        }
        continue;   // retry the loop with the smaller, persisted dispatch size
      }

      for (const hit of hits) {
        // `stride`, not `keysPerThread`: it is the stride actually baked into the
        // uploaded table, which is what the shader stepped by. Equal today because
        // ensureOffsetTable() makes them equal, and reading the returned value keeps
        // that true even if the table logic changes later.
        const foundPriv = chunkPriv + BigInt(hit.threadId * stride + hit.keyOffset);
        // Drop hits whose privkey falls outside the configured range. These come
        // from threads scanning the "negative tail" when chunkPriv < rangeStart;
        // their pubkey collision with the target is astronomically unlikely but
        // wouldn't be a Puzzle solution anyway.
        if (foundPriv < opts.rangeStart || foundPriv > opts.rangeEnd) continue;
        // Independently re-derive the PKH on the CPU before acting on this key. The GPU
        // reports only (thread_id, key_offset), so a reconstruction bug yields a WRONG
        // key that looks entirely valid, and the right one is unrecoverable because
        // nothing else recorded it. One scalarMul on a once-in-the-universe event costs
        // nothing; being silently wrong here costs the prize. Loud and skipped rather
        // than claimed, because a key we cannot confirm is worse than no key.
        const checkPkh = await privToPkh(foundPriv);
        if (!checkPkh.every((b, k) => b === targetPkhArr[k])) {
          console.error(
            "REJECTED a GPU hit: CPU re-derivation disagrees. This is a bug, not bad luck.",
            { thread: hit.threadId, keyOffset: hit.keyOffset, stride,
              keysPerThread, dispatchKeys: this.keysPerDispatch,
              priv: foundPriv.toString(16) },
          );
          continue;
        }
        await onHit(foundPriv);
        if (!this.running) return;
      }

      this.totalChecked += BigInt(totalKeysThisDispatch);
      this.recalibrate(elapsedMs);

      const now = performance.now();
      this.recordSample(now, elapsedMs, totalKeysThisDispatch);
      if (now - this.lastReportTime > 200) {
        const rate = this.currentRate();
        opts.onProgress({
          totalChecked: this.totalChecked,
          rate,
          dispatchKeys: this.keysPerDispatch,
          chunkPriv,
          chunkSpan: BigInt(totalKeysThisDispatch),
        });
        this.lastReportTime = now;
      }

      // Yield to keep the page responsive.
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  stop() {
    this.running = false;
  }
}
