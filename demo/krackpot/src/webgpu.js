// WebGPU device init + a "run-once" compute helper for self-tests.

let _device = null;
// Set once a device has been lost, and never cleared. Read by the capability check so a
// driver crash reports itself as one. Without this the loss surfaces as whichever test ran
// next failing with "WebGPU not initialised", which sends the user hunting a maths bug when
// their driver reset underneath them. Not cleared on re-init on purpose: the fact that a
// loss happened at all is the diagnostic.
let _lost = null;
export const deviceLostInfo = () => _lost;

// Shader modules and pipelines, reused across calls.
//
// WHY. runComputeOnce used to create a fresh GPUShaderModule AND a fresh compute pipeline on
// every call. The capability suite is 54 tests over about 9 distinct entry points, so a full run
// compiled 54 modules and 54 pipelines to do the work of roughly 15, and called
// getCompilationInfo 54 times to check 6 distinct sources.
//
// That is suspected of wedging some Windows drivers. Three machines cannot finish the check:
// two RTX 4060s die at the fifth test and an RX 7800 XT around the forty-third, each leaving the
// GPU pinned near 100% until the browser closes, which looks like a stuck compile rather than a
// wrong answer. The test where it dies cannot be the cause, because tests 1 and 5 go through the
// same module and the same entry point and differ only in their input, and nothing in a
// straight-line 256-bit add depends on data. Firefox on the same hardware dies at the SECOND
// test, which is the heavy search kernel, so the pattern tracks compile cost rather than
// arithmetic. Reducing compilations is worth doing on its own merits either way.
//
// INVALIDATION IS THE RISK, not the caching. Pipelines and modules belong to a device, and this
// app re-acquires the device after loss (see ensureDevice). Handing a fresh device an object from
// a dead one is a worse failure than the hang, so the caches are stamped with the device they
// were built for and cleared the moment a different device appears. Identity comparison is
// enough because initWebGPU always constructs a new GPUDevice.
let _cacheDevice = null;
const _moduleCache = new Map();     // shaderCode -> GPUShaderModule
const _pipelineCache = new Map();   // shaderCode + "\u0000" + entryPoint -> GPUComputePipeline

// Which await runComputeOnce is currently sitting in. Read by the capability check when a test
// times out, because WHERE it stopped is the one fact that decides what is wrong and the reports
// so far cannot supply it.
//
// A stuck shader compile is CPU work. A stuck dispatch pins the GPU. Three Windows machines
// report the GPU held near 100% until the browser closes, which points at execution rather than
// compilation, and that is an argument against the caching below being the cure. But nobody has
// been able to say whether their run stopped in createComputePipelineAsync or in mapAsync, and
// the two need completely different fixes. So record it rather than keep guessing:
//   "pipeline" in the message  -> a compile hang, and caching plausibly helps
//   "mapAsync" in the message  -> an execution hang, and caching cannot possibly help
let _phase = "idle";
export const currentGpuPhase = () => _phase;

// Exposed for tests and for the console: how much compiling was actually avoided.
export const shaderCacheStats = () => ({
  modules: _moduleCache.size,
  pipelines: _pipelineCache.size,
  hits: _cacheHits,
  misses: _cacheMisses,
});
let _cacheHits = 0, _cacheMisses = 0;

const dropCachesIfDeviceChanged = (device) => {
  if (_cacheDevice === device) return;
  _moduleCache.clear();
  _pipelineCache.clear();
  _cacheDevice = device;
};

export const initWebGPU = async () => {
  if (!navigator.gpu) throw new Error("WebGPU not supported in this browser");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("no WebGPU adapter (try a fresh Chrome/Edge build)");
  const device = await adapter.requestDevice();
  device.lost.then((info) => {
    console.warn("WebGPU device lost:", info.message, info.reason);
    _lost = { message: info.message || "(no message)", reason: info.reason || "unknown" };
    _device = null;
    // Release the cached modules and pipelines straight away rather than waiting for the next
    // call to notice. They belong to a device that no longer exists, so holding them keeps dead
    // GPU objects alive and gains nothing. dropCachesIfDeviceChanged would catch it anyway; this
    // is the belt to its braces, and it matters more here because a lost device is exactly when
    // the driver is already unhappy.
    _moduleCache.clear();
    _pipelineCache.clear();
    _cacheDevice = null;
  });
  _device = device;
  return { adapter, device };
};

export const getDevice = () => {
  if (!_device) {
    throw new Error(_lost
      ? `WebGPU device was lost (${_lost.reason}): ${_lost.message}`
      : "WebGPU not initialised");
  }
  return _device;
};

// Return a live device, re-acquiring if the old one is gone.
//
// The capability check needed this and did not have it. initWebGPU() ran exactly once, at page
// load, and the test path only ever called getDevice(), which throws when _device is null. So a
// device lost at ANY point after the first check made every subsequent test throw, and clicking
// "Re-check GPU" reported the hardware as broken when the only thing wrong was a dropped device.
// Reproduced in Safari on a machine whose first check had passed: Safari reclaims idle WebGPU
// devices readily, and private browsing "worked" only because it never had a prior session to
// lose one from. The search loop already handled this (coordinator.setup() re-acquires); the
// tests were the path that did not.
//
// Returns { device, reacquired } so the caller can say which happened, because "your driver
// dropped the device and we got a new one" and "your GPU computes the wrong answers" deserve
// very different words.
export const ensureDevice = async () => {
  if (_device) return { device: _device, adapter: null, reacquired: false };
  const { adapter, device } = await initWebGPU();
  return { device, adapter, reacquired: true };
};

// Which browser is running, for the GPU / BROWSER telemetry tile.
//
// The browser turns out to matter as much as the silicon for this workload: a
// MacBook Pro M3 Pro measured 17.5M keys/sec on Chromium and 7.7M on Firefox,
// about 44%. Worse, Firefox is the ONLY engine that leaves adapter.info's vendor
// and architecture both empty, so the tile fell back to the bare string
// "unknown" on exactly the browser where knowing was most valuable. A community
// report on 2026-08-18 cost a round trip to interpret for that reason, and the
// same 44% factor then explained a Radeon 780M reading that had been misfiled as
// a contended run.
//
// THE RULE, stated because a half-and-half one is worse than either: report the
// BRAND where a UA token identifies it, and fall back to the ENGINE family when it
// does not. A first version reported "brave" (a brand, Blink underneath) alongside
// "safari" for Chrome-on-iOS (an engine, Chrome brand), which followed no rule at
// all and would have filed rates against the wrong thing.
//
// iOS gets compound tokens. Apple mandates WebKit there, so Firefox on iOS is NOT
// Gecko and must never read as plain "firefox" or a rate lands against an engine
// that never ran it. "firefox-ios" carries both halves: the brand the reporter
// sees, and the suffix that explains the performance.
//
// Order is load-bearing three times over. The iOS wrappers go first because their
// UAs contain "Safari/" and no "Chrom", so any later test wins wrongly. Every
// Chromium-family brand carries "Chrome/", so each must precede the generic Chrome
// test. And "Safari/" appears in every Chromium UA, so it goes last.
//
// Unknown Chromium derivatives falling through to "chrome" is intended, not sloppy:
// they all run Blink and Dawn, so the engine answer is right even when the brand is
// missing, and for this workload the engine is what moves the number.
//
// Returns null rather than guessing, so the caller omits the segment entirely.
//
// It also never throws, and that guard is not defensive habit. The only caller sits
// inside the try block that wraps initWebGPU(), whose catch does an early return
// before wireSearch() runs. So an exception raised HERE would disable the Start
// button and print the "WebGPU not supported" panel, complete with its Linux/Vulkan
// advice, on a machine whose WebGPU is perfectly fine. A cosmetic label would
// present as total hardware failure, and the message would send the user hunting
// the wrong problem.
//
// The reachable throw is the navigator.brave read: an anti-fingerprinting extension
// or a navigator Proxy can define that property as a throwing getter, and this
// audience over-indexes on exactly those hardened setups. Reading navigator.userAgent
// through such a Proxy throws too, before the `|| ""` can help. Hence the whole body,
// not one property.
// The warn matters: without it this guard hides its own failures. A refactor typo or
// a future navigator shape change would silently drop the browser segment forever and
// look identical to an unrecognised UA. Console only, never a banner, because a
// missing label does not deserve the user's attention.
export const browserName = () => {
  try {
    return detectBrowser();
  } catch (e) {
    console.warn("browserName() failed, omitting the browser segment:", e);
    return null;
  }
};

const detectBrowser = () => {
  const ua = navigator.userAgent || "";

  // iOS wrappers. WebKit underneath regardless of brand.
  if (/\bCriOS\//.test(ua)) return "chrome-ios";
  if (/\bFxiOS\//.test(ua)) return "firefox-ios";
  if (/\bEdgiOS\//.test(ua)) return "edge-ios";

  // Chromium-family brands, all of which also carry "Chrome/".
  // navigator.brave is an existence check, not Brave's own async isBrave(). It is a
  // heuristic: anything that defines that property gets labelled brave. Accepted
  // because the alternative makes this function async for a telemetry label, and
  // because a wrong brand here costs a follow-up question, not a wrong rate. Note
  // it also reveals Brave, which Brave deliberately hides from its UA; that is
  // acceptable only because this string is rendered on screen and never sent
  // anywhere (nothing reads #m-gpu, and the analytics beacon carries page views).
  if (navigator.brave) return "brave";
  if (/\bEdgA?\//.test(ua)) return "edge";              // EdgA/ on Android, Edg/ elsewhere
  if (/\bOPR\//.test(ua)) return "opera";
  if (/\bVivaldi\//.test(ua)) return "vivaldi";
  if (/\bYaBrowser\//.test(ua)) return "yandex";
  if (/\bSamsungBrowser\//.test(ua)) return "samsung";
  if (/\bDuckDuckGo\//.test(ua)) return "duckduckgo";
  if (/\bElectron\//.test(ua)) return "electron";
  if (/;\s*wv\)/.test(ua)) return "android-webview";
  // Named separately because headless runs may have no real GPU, and such a rate
  // must not be filed as if a normal Chrome user produced it.
  if (/\bHeadlessChrome\//.test(ua)) return "headless-chrome";

  if (/\bFirefox\//.test(ua)) return "firefox";
  if (/\bChromium\//.test(ua)) return "chromium";
  if (/Chrome\//.test(ua)) return "chrome";
  // Reachable only once every Chromium brand above has been excluded. The extra
  // guard is redundant today and kept so a future reordering cannot silently label
  // Chrome as Safari, which is exactly what happened once already.
  if (/\bSafari\//.test(ua) && !/Chrom/.test(ua)) return "safari";
  return null;
};

// Build a platform-aware explanation for a failed WebGPU init.
// The big one is Linux + a Chromium-family browser: WebGPU there runs on the
// Vulkan backend, which ships DISABLED on many distros/drivers, so
// requestAdapter() returns null even though the hardware is perfectly capable.
// A generic "not supported" dead-ends exactly those users, so point them at the
// flags that fix it. (Verified case: Brave on Ubuntu 24.04 + Intel UHD, Mesa —
// about:gpu showed "Vulkan: Disabled" and requestAdapter failed.)
export const describeWebGPUFailure = (errMessage) => {
  const ua = navigator.userAgent || "";
  const uaPlat = (navigator.userAgentData && navigator.userAgentData.platform) || "";
  const isLinux = /Linux/.test(uaPlat + " " + ua) && !/Android/i.test(ua);
  const isFirefox = /Firefox/i.test(ua);
  const isChromium = /Chrome|Chromium|Edg\//i.test(ua);

  const base = "FAILED: " + errMessage;

  if (isLinux && isChromium) {
    return base + "\n\n" +
      "Linux fix: WebGPU here runs on Vulkan, which is often disabled by default.\n" +
      "1. Open chrome://flags  (brave://flags on Brave, edge://flags on Edge).\n" +
      "2. Set #enable-vulkan and #enable-unsafe-webgpu to Enabled.\n" +
      "3. Relaunch the browser, then reload this page.\n" +
      "4. Check chrome://gpu shows \"Vulkan: Enabled\". If it won't turn on, install a\n" +
      "   Vulkan driver first: sudo apt install mesa-vulkan-drivers (or your distro's equivalent).";
  }
  if (isLinux && isFirefox) {
    return base + "\n\n" +
      "Linux fix: Firefox WebGPU on Linux is limited. Open about:config, set\n" +
      "dom.webgpu.enabled to true and relaunch — or use Chrome/Chromium with Vulkan\n" +
      "enabled (chrome://flags → #enable-vulkan).";
  }
  return base + "\n\n" +
    "WebGPU requires Chrome/Edge 113+, or Safari 18+ with the feature enabled. " +
    "The page must be served over http://localhost or https.";
};

// Run a single compute dispatch against an input buffer, read back the output buffer.
// `entryPoint` selects which @compute function in the shader to call.
// Dispatches workgroup_size * (1,1,1).
export const runComputeOnce = async ({ shaderCode, entryPoint, inputBytes, outputByteLen, dispatch = [1, 1, 1] }) => {
  const device = getDevice();
  dropCachesIfDeviceChanged(device);

  let module = _moduleCache.get(shaderCode);
  if (module) {
    _cacheHits++;
  } else {
    _cacheMisses++;
    _phase = "createShaderModule";
    module = device.createShaderModule({ code: shaderCode });

    // Surface compilation errors early. Only on first compile of a given source, since the
    // answer cannot change for the same string on the same device. Deliberately checked BEFORE
    // the module goes in the cache, so a source that fails to compile keeps failing loudly
    // rather than being cached and silently skipped on the next call.
    _phase = "getCompilationInfo";
    const info = await module.getCompilationInfo();
    for (const m of info.messages) {
      if (m.type === "error") {
        console.error("WGSL compile error:", m);
        throw new Error(`WGSL compile error: ${m.message} at line ${m.lineNum}`);
      }
    }
    _moduleCache.set(shaderCode, module);
  }

  // Keyed on both, because one module carries several @compute entry points and each needs its
  // own pipeline. NUL as the separator: it cannot occur in WGSL source or in an identifier, so
  // no pair of inputs can collide on the same key.
  const pipelineKey = shaderCode + "\u0000" + entryPoint;
  let pipeline = _pipelineCache.get(pipelineKey);
  if (pipeline) {
    _cacheHits++;
  } else {
    _cacheMisses++;
    _phase = "createComputePipelineAsync";
    pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint },
    });
    _pipelineCache.set(pipelineKey, pipeline);
  }

  // Named so the capability-check watchdog stops charging allocation time against the COMPILE
  // budget. Everything from here to queue.submit used to inherit createComputePipelineAsync's
  // long budget, which would have given a driver stalled in createBuffer three minutes instead
  // of twenty-five seconds. Deliberately NOT in COMPILE_PHASES: unclassified defaults short.
  _phase = "buffers";
  const inSize = Math.max(16, inputBytes ? inputBytes.byteLength : 16);
  const inBuf = device.createBuffer({
    size: inSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  if (inputBytes && inputBytes.byteLength > 0) {
    device.queue.writeBuffer(inBuf, 0, inputBytes);
  }

  const outBuf = device.createBuffer({
    size: outputByteLen,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readBuf = device.createBuffer({
    size: outputByteLen,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: inBuf } },
      { binding: 1, resource: { buffer: outBuf } },
    ],
  });

  const cmd = device.createCommandEncoder();
  const pass = cmd.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(dispatch[0], dispatch[1], dispatch[2]);
  pass.end();
  cmd.copyBufferToBuffer(outBuf, 0, readBuf, 0, outputByteLen);
  _phase = "queue.submit";
  device.queue.submit([cmd.finish()]);

  _phase = "mapAsync";
  await readBuf.mapAsync(GPUMapMode.READ);
  const out = new Uint8Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();
  _phase = "idle";   // got out cleanly, so a later timeout cannot blame this call

  inBuf.destroy();
  outBuf.destroy();
  readBuf.destroy();

  return out;
};

// Helpers to pack/unpack u256 (8 little-endian u32 limbs = 32 bytes).
export const bigIntToLimbBytes = (n) => {
  const bytes = new Uint8Array(32);
  let x = n;
  for (let i = 0; i < 8; i++) {
    const limb = Number(x & 0xFFFFFFFFn);
    bytes[i * 4]     = limb & 0xFF;
    bytes[i * 4 + 1] = (limb >>> 8) & 0xFF;
    bytes[i * 4 + 2] = (limb >>> 16) & 0xFF;
    bytes[i * 4 + 3] = (limb >>> 24) & 0xFF;
    x >>= 32n;
  }
  return bytes;
};

export const limbBytesToBigInt = (bytes, offset = 0) => {
  let n = 0n;
  for (let i = 7; i >= 0; i--) {
    const limb =
      (bytes[offset + i * 4]) |
      (bytes[offset + i * 4 + 1] << 8) |
      (bytes[offset + i * 4 + 2] << 16) |
      (bytes[offset + i * 4 + 3] << 24);
    n = (n << 32n) | BigInt(limb >>> 0);
  }
  return n;
};
