// Entry point. Initialises WebGPU, wires the test runner, and wires the search
// start/stop buttons. Tests run as a silent preflight on Start when the
// (adapter + shader source) fingerprint matches the last successful run; only
// re-validation due to a code/driver change blocks Start with a visible run.

import { initWebGPU, describeWebGPUFailure, browserName, deviceLostInfo, ensureDevice } from "./webgpu.js";
import { runAllTests } from "./tests.js";
import { SearchCoordinator } from "./coordinator.js";
import { PUZZLE_UTXOS } from "./puzzle-utxos.js";
import { enqueue as enqueueClaim, wireAutoDrain, saveRecoveredKey } from "./claim-queue.js";
import { parseShareParams, buildShareURL, isLikelyBitcoinAddress } from "./share.js";
import { TARGET_ADDRESS, RANGE_START, RANGE_END, DEFAULT_PAYOUT_ADDRESS } from "./config.js";

import { testBigintWGSL }    from "./shaders/test_bigint.js";
import { testSha256WGSL }    from "./shaders/test_sha256.js";
import { testRipemd160WGSL } from "./shaders/test_ripemd160.js";
import { testSecp256k1WGSL } from "./shaders/test_secp256k1.js";
import { testPipelineWGSL }  from "./shaders/test_pipeline.js";
import { searchWGSL }        from "./shaders/search.js";

const PREFLIGHT_KEY = "puzzlecrack.preflight";
const PAYOUT_KEY = "puzzlecrack.payout";
const INSTALL_DISMISSED_KEY = "puzzlecrack.installDismissed";
const TAB_NOTICE_DISMISSED_KEY = "puzzlecrack.tabNoticeDismissed";

// Background gaps shorter than this are ordinary tab switching and not worth a
// word. See docs/tab-visibility-notice.md for the measurement behind all of it:
// a five-minute hidden tab produced zero dispatches, so "paused" is literal.
const TAB_PAUSE_MIN_MS = 30_000;
const PAUSED_TITLE = "Paused - Krackpot";

const $ = (id) => document.getElementById(id);
const setGpuInfo = (text) => { $("gpu-info").textContent = text; };

// The #gpu-status panel is shown for TWO different failures and its copy is hardcoded for only
// one of them. Reusing it for a capability failure told @Lokuyow "Your browser can't reach
// WebGPU" while the adapter line directly beneath said nvidia / lovelace / chrome, and then
// advised him to use Chrome on a desktop, which is what he was already on. Wrong panel, wrong
// advice, and it made a real bug report harder to act on rather than easier.
//
// So the story is set explicitly on both paths. Never rely on the markup default: a session can
// hit one failure and then the other, and stale copy is how this happened in the first place.
// Null-safe on purpose. These three ids are NEW, so a cached index.html lacking them paired with
// a fresh main.js would throw a TypeError inside the very failure path that exists to explain the
// failure, turning a diagnosable refusal into a blank panel. Degrading to the markup's built-in
// copy is worse than the right copy and far better than that. Fourth time this session that
// reading tolerantly across a cache boundary has been the difference.
const setGpuStatus = ({ title, lede, help }) => {
  const set = (id, text) => {
    const el = $(id);
    if (el && text !== undefined) el.textContent = text;
  };
  set("gpu-status-title", title);
  set("gpu-status-lede", lede);
  set("gpu-status-help", help);
};

const GPU_STATUS_NO_WEBGPU = {
  title: "Your browser can't reach WebGPU",
  lede: "The search runs on your GPU through WebGPU, and this browser or device can't get to it " +
        "right now. It's not you, and there's often a quick fix.",
  help: "Chrome or Edge on a desktop give the smoothest run. Either way, you can still read how " +
        "Krackpot works while you're here.",
};

// A driver crash is not a maths failure, and the panel used to claim it was. The banner below
// already says "GPU DRIVER CRASHED", so a title reading "your GPU works, but it failed the maths
// check" directly contradicted it. Different cause, different action, so different copy.
const GPU_STATUS_DEVICE_LOST = {
  title: "Your GPU driver crashed during the check",
  lede:
    "WebGPU started and your card was detected, then the driver stopped responding and the " +
    "device was lost. That points at a driver or system fault rather than anything wrong with " +
    "your hardware.",
  help:
    "Reloading often works. So can updating the graphics driver, or closing other GPU-heavy " +
    "apps and trying again.",
};

const GPU_STATUS_CHECK_FAILED = {
  title: "Your GPU works, but it failed the maths check",
  lede:
    "WebGPU started fine and your card was detected, so this is not a browser or hardware " +
    "support problem. One of the correctness checks did not give the answer it should, and the " +
    "search stays locked because a GPU that computes the wrong answer would burn electricity " +
    "forever without ever finding anything.",
  // Reloading is real advice here, not a shrug. Some drivers need longer than our budget to
  // compile this shader the first time, and because a WebGPU compile cannot be cancelled the
  // driver finishes and caches it anyway, so the next attempt gets further. One reporter's card
  // passed on the third try for exactly this reason.
  help:
    "If this says a test timed out, try reloading and running it again, up to a couple of times. " +
    "Some graphics drivers are slow to compile this shader the first time and then keep the " +
    "result, so a second or third attempt often gets through. This is more likely my bug than " +
    "yours, so please send me the three lines below if it keeps failing.",
};
const setBanner = (text, fail = false) => {
  const el = $("result-banner");
  el.hidden = false;
  el.classList.toggle("fail", fail);
  el.textContent = text;
};
const fmt = (n) => n.toLocaleString();
const fmtBig = (n) => Number(n).toLocaleString();
const setTxStatus = (text, title = text) => {
  const el = $("build-version");
  if (!el) return;
  const label = el.querySelector("span:last-child");
  if (label) label.textContent = text;
  el.title = title;
};
const showPayoutTransaction = (txid, payload, { title, note, userAddress, devAddress, format = "hex" } = {}) => {
  const panel = $("payout-transaction-panel");
  const titleEl = $("payout-transaction-title");
  const noteEl = $("payout-transaction-note");
  const txidEl = $("payout-txid");
  const userAddressEl = $("payout-user-address");
  const output0El = $("payout-output0");
  const devAddressEl = $("payout-dev-address");
  const output1El = $("payout-output1");
  const txLabelEl = document.querySelector('label[for="payout-txhex"]');
  const hexEl = $("payout-txhex");
  const copyBtn = $("copy-payout-transaction");
  if (!panel || !titleEl || !noteEl || !txidEl || !userAddressEl || !output0El || !devAddressEl || !output1El || !txLabelEl || !hexEl || !copyBtn) return;
  if (title) titleEl.textContent = title;
  if (note) noteEl.textContent = note;
  txidEl.textContent = txid;
  const user = userAddress || $("user-payout-address")?.value.trim() || DEFAULT_PAYOUT_ADDRESS;
  const dev = devAddress || DEFAULT_PAYOUT_ADDRESS;
  userAddressEl.textContent = user;
  output0El.textContent = `6 BTC → ${user}`;
  devAddressEl.textContent = dev;
  output1El.textContent = `remainder → ${dev}`;
  const text = format === "json"
    ? JSON.stringify({
        version: 2,
        locktime: 0,
        ins: [{
          n: 0,
          script: { asm: "", hex: "" },
          sequence: 4294967295,
          txid: "0000000000000000000000000000000000000000000000000000000000000000",
          witness: [],
        }],
        outs: [
          {
            n: 0,
            script: {
              addresses: [user],
              asm: "OP_0 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              hex: "0014aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
            value: 600000000,
          },
          {
            n: 1,
            script: {
              addresses: [dev],
              asm: "OP_0 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              hex: "0014bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
            value: 100000000,
          },
        ],
        hash: txid,
        txid,
      }, null, 2)
    : payload;
  hexEl.value = text;
  hexEl.rows = format === "json" ? 16 : 6;
  hexEl.setAttribute("aria-label", format === "json" ? "Mock transaction JSON" : "Signed transaction hex");
  txLabelEl.textContent = format === "json" ? "MOCK TX JSON" : "SIGNED HEX";
  panel.hidden = false;
  copyBtn.textContent = format === "json" ? "Copy JSON" : "Copy hex";
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "Copied";
      setTimeout(() => { copyBtn.textContent = format === "json" ? "Copy JSON" : "Copy hex"; }, 1200);
    } catch {
      hexEl.focus();
      hexEl.select();
    }
  };
};

const MOCK_PAYOUT_TRANSACTION = {
  txid: "0000000000000000000000000000000000000000000000000000000000000000",
  hex: "020000000100000000000000000000000000000000000000000000000000000000000000000000000000ffffffff020046c32300000000160014aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa00e1f50500000000160014bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb00000000",
};

// Console calling card. The repo is closed, so the audit surface is the
// unminified source shipped to the browser. Anyone who opens devtools gets
// pointed straight at it. (Console styling ignores page @font-face, so the
// brand line falls back to a condensed sans; size and colour still land.)
(() => {
  const brand = "font:800 46px/1.1 'Anton','Arial Narrow',sans-serif;color:#db3b26;letter-spacing:1px";
  // Group the card under the KRACKPOT header so it reads as one block, indented
  // and set apart from the normal-weight runtime logs. Body lines keep the
  // console's default colour (theme-safe) but go bold.
  const note = "font-weight:bold";
  console.group("%cKRACKPOT", brand);
  console.log("%cUnminified on purpose. No build step, no bundler: what you read here is what runs.", note);
  console.log("%cStart at src/main.js. The search kernel (secp256k1, SHA-256, RIPEMD-160) is src/shaders/search.js.", note);
  console.log("%cHow it works: https://krackpot.io/blog/how-it-works", note);
  console.groupEnd();
})();

// Rebuild the always-visible, copy-ready share link from the current form
// state. buildShareURL omits an invalid/empty `pay` on its own, so a partial
// address just yields a link without the pay param rather than a broken one.
const refreshShareURL = () => {
  const field = $("share-url");
  if (!field) return;
  const pay = $("user-payout-address").value.trim();
  field.value = buildShareURL({
    pay: pay || undefined,
    autostart: $("share-autostart").checked,
  });
};

// Surface which cached build is live. The service-worker cache name embeds
// sw.js's VERSION (`puzzlecrack-<VERSION>`) and `activate` deletes all others,
// so reading it back tells you at a glance whether a device is on the latest
// deploy — useful when a test device is serving a stale cache.
const showBuildVersion = async () => {
  const el = $("build-version");
  if (!el || !("caches" in window)) return;
  try {
    const keys = await caches.keys();
    const c = keys.find((k) => k.startsWith("puzzlecrack-"));
    if (c) el.textContent = `build ${c.replace("puzzlecrack-", "")}`;
  } catch { /* Cache API unavailable — leave blank */ }
};

// Expected time to find the key at the current rate. Random sampling means the
// median (~half the full-sweep time) is the honest headline, so we show just
// that — in human-readable units (no scientific notation).
const formatEta = (rangeBig, rate) => {
  if (rate <= 0) return "—";
  const fullSec = Number(rangeBig) / rate;
  if (!isFinite(fullSec)) return "—";
  return `${prettyDuration(fullSec / 2)} (median, random search)`;
};

// Word-scale names for the enormous year counts this workload produces.
const YEAR_SCALES = [
  [1e24, "septillion"], [1e21, "sextillion"], [1e18, "quintillion"],
  [1e15, "quadrillion"], [1e12, "trillion"], [1e9, "billion"],
  [1e6, "million"], [1e3, "thousand"],
];

const prettyDuration = (sec) => {
  if (sec < 60) return `${sec.toFixed(1)} s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)} min`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} h`;
  const days = sec / 86400;
  if (days < 365) return `${days.toFixed(1)} days`;
  const years = days / 365.25;
  if (years < 1000) return `${Math.round(years).toLocaleString()} years`;
  for (const [v, name] of YEAR_SCALES) {
    if (years >= v) {
      const q = years / v;
      return `${q < 10 ? q.toFixed(1) : Math.round(q).toLocaleString()} ${name} years`;
    }
  }
  return `${Math.round(years).toLocaleString()} years`;
};

// Hash (adapter identity, shader sources) into a stable fingerprint. A match
// against the stored value means the math hasn't changed and previously-passed
// tests are still valid — safe to skip the preflight.
const computeFingerprint = async (adapter) => {
  const info = adapter.info || {};
  const allShaders = [
    testBigintWGSL, testSha256WGSL, testRipemd160WGSL,
    testSecp256k1WGSL, testPipelineWGSL, searchWGSL,
  ].join("\n---\n");
  const text = JSON.stringify({
    vendor: info.vendor || "",
    architecture: info.architecture || "",
    device: info.device || "",
    description: info.description || "",
  }) + "\n" + allShaders;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
};

// Bumped when the SET of blocking tests changes in a way a stored pass should not survive.
// The fingerprint hashes adapter.info and the WGSL sources but NOT the test manifest, so
// without this a newly added blocking test would be silently skipped by every existing
// stored pass — the gate would quietly stop enforcing the thing it was just taught to check.
// v2: blocking/diagnostic split, and diagnostics dropped from the automatic preflight.
const GATE_VERSION = 2;

const getStoredPreflight = () => {
  try { return JSON.parse(localStorage.getItem(PREFLIGHT_KEY) || "null"); }
  catch { return null; }
};

const setStoredPreflight = (fingerprint) => {
  localStorage.setItem(PREFLIGHT_KEY, JSON.stringify({
    fingerprint,
    gateVersion: GATE_VERSION,
    passedAt: new Date().toISOString(),
  }));
};

// A stored pass counts only if it was produced by the same shaders AND the same gate rules.
// Note the deliberate asymmetry: this version went UP, but the blocking set only SHRANK, so
// every device that passed under v1 would also pass under v2. Re-running them would be
// pointless churn on ~40 working devices, so a missing gateVersion is treated as acceptable
// rather than stale. Bump-and-reject is for future changes that ADD blocking coverage.
const preflightIsValid = (stored, fingerprint) =>
  !!stored && stored.fingerprint === fingerprint
  && (stored.gateVersion === undefined || stored.gateVersion <= GATE_VERSION);

let adapterRef = null;
let coordinator = null;

// Install-to-home-screen: we suppress the browser's own (aggressive) default
// prompt and stash the event, then surface our own in-app CTA only after the
// user has actually used the app (valid payout + search started). `null` until
// the browser fires beforeinstallprompt; nulled again once used or installed.
let deferredInstallPrompt = null;

// The install CTA is deliberately delayed past the FIRST search start — showing
// it the instant cracking begins is too abrupt. The first successful start
// (valid payout) only "arms" it; it then surfaces on the next natural beat:
// either when the user navigates back to the tab, or on a second successful
// start. `true` once armed.
let installCtaArmed = false;

// Reveal the in-app install CTA — but only if the browser has offered a prompt,
// the user hasn't already dismissed it, and the app isn't already installed
// (running standalone). Called after a real search start, never on page load.
const maybeShowInstallCTA = () => {
  const cta = $("install-cta");
  if (!cta || !deferredInstallPrompt) return;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  if (standalone) return;
  try { if (localStorage.getItem(INSTALL_DISMISSED_KEY)) return; } catch { /* storage off — show it */ }
  cta.hidden = false;
};

// Once the CTA is armed on the first start, reveal it the next time the user
// returns to the tab. Self-removing: it only needs to fire once.
const onVisibleShowInstallCTA = () => {
  if (document.visibilityState !== "visible") return;
  document.removeEventListener("visibilitychange", onVisibleShowInstallCTA);
  maybeShowInstallCTA();
};

// Wire the beforeinstallprompt capture + the CTA's own buttons. Registered once
// at startup; the CTA itself stays hidden until maybeShowInstallCTA() reveals it.
const wireInstallPrompt = () => {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();            // suppress the browser's default install banner
    deferredInstallPrompt = e;     // stash it for our own CTA button
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    const cta = $("install-cta");
    if (cta) cta.hidden = true;
  });

  const cta = $("install-cta");
  const installBtn = $("install-app");
  const dismissBtn = $("install-dismiss");
  if (!cta || !installBtn || !dismissBtn) return;

  installBtn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) { cta.hidden = true; return; }
    const prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;  // a prompt event can only be used once
    cta.hidden = true;
    try { await prompt.prompt(); } catch { /* user dismissed the native prompt */ }
  });

  dismissBtn.addEventListener("click", () => {
    cta.hidden = true;
    try { localStorage.setItem(INSTALL_DISMISSED_KEY, "1"); } catch { /* storage off — dismissal just isn't remembered */ }
  });
};

// On a verified hit: build the tx variants and submit PRIVATELY (three tiers),
// never to the public mempool (that exposes the pubkey and gets it front-run).
// Always surface the privkey + signed hex first so the finder can recover by
// hand. Orchestration lives in claim-orchestrator.js; see docs/claim-privacy.md.
const runClaim = async ({ priv, hex, addr, userPayoutAddress }) => {
  // FIRST, before anything that can fail: log and persist the key. Every path
  // below (missing snapshot, build error, offline, submit failure) can lose the
  // tx and still be recovered from the key alone, so the key must outlive them.
  console.log("private key (hex): 0x" + hex);
  const keySaved = saveRecoveredKey({ privHex: hex, address: addr });
  const keyNote = keySaved
    ? `The key is saved in this browser (localStorage "puzzlecrack.recoveredKeys") — copy it somewhere safe now.`
    : `WARNING: could not save the key to this browser. COPY IT NOW, it exists nowhere else.`;

  // Shared by the TWO paths that hand the finder a key and no transaction: a missing
  // UTXO snapshot, and a claim build that failed. That is the most dangerous state this
  // app can produce, because the obvious way to spend a recovered puzzle key is the way
  // that loses it. A puzzle key sits in a narrow range, so any public broadcast reveals
  // a pubkey that falls to Pollard's kangaroo in minutes; that is how 66 and 69 were
  // taken. Defined once so the two banners cannot drift apart.
  const manualClaimWarning =
    `You have to build and sign the spend yourself. Never share this private key with ` +
    `anyone and never paste it into a website. Once you have a signed transaction, submit ` +
    `THAT privately via slipstream.mara.com. Do NOT send it to a public explorer, a public ` +
    `node, or any online service that broadcasts, or it will be front-run and stolen ` +
    `before it confirms.`;

  const utxos = (PUZZLE_UTXOS.addresses && PUZZLE_UTXOS.addresses[addr]) || [];
  if (utxos.length === 0) {
    setTxStatus("No tx");
    setBanner(
      `HIT! priv=0x${hex} for ${addr}, but no UTXO snapshot was captured for this ` +
      `address. ${manualClaimWarning} ${keyNote}`, true);
    return;
  }

  // Decide where the 6 BTC user output goes. Valid payout address -> pay it;
  // otherwise fall back to the developer address rather than risk the prize
  // vanishing. A hit is a once-in-the-universe event; never let the key slip.
  const fellBackToDev = !isLikelyBitcoinAddress(userPayoutAddress);

  let result;
  try {
    // Deadlined for the same reason the gift-wrap is, and it matters more here.
    // prize-claim.js statically imports @scure/btc-signer from esm.sh, so this line
    // is where that fetch happens, and it sits BEFORE any tier has run. A network
    // that drops packets rather than refusing them leaves an import pending, not
    // rejected, so without this the hit path could hang here indefinitely: nothing
    // submitted, no banner, and a finder staring at an idle page. With it, the
    // failure becomes the manual-claim banner below, which carries the key and the
    // do-not-broadcast warning. Generous, because this is the prize path.
    const CLAIM_IMPORT_DEADLINE_MS = 20000;
    const [{ orchestrateClaim }] = await Promise.race([
      Promise.all([
        import("./claim-orchestrator.js"),
        import("./prize-claim.js"),
      ]),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(
          `claim libraries did not load after ${CLAIM_IMPORT_DEADLINE_MS / 1000}s`)),
        CLAIM_IMPORT_DEADLINE_MS)),
    ]);
    const destination = fellBackToDev ? DEFAULT_PAYOUT_ADDRESS : userPayoutAddress;
    result = await orchestrateClaim({
      priv, privHex: hex, addr, destination, fellBackToDev, utxos,
      online: navigator.onLine,
    });
  } catch (e) {
    setTxStatus("No tx");
    // This catch had no anti-front-running warning, which made it the most dangerous
    // banner in the app: it hands over a key with no transaction and no guidance.
    //
    // It is also the likeliest shape of a hit years from now. prize-claim.js pulls
    // @scure/btc-signer from esm.sh and is only imported on a hit, so if that CDN is
    // gone the tx cannot be built at all and none of the three tiers can run. The key
    // still survives, because it is saved above before anything here can fail.
    //
    // Deliberately says "did not produce a usable signed transaction" rather than "no
    // transaction was built". This catch is broader than the failed-import case: it also
    // covers a throw from orchestrateClaim, which can happen after the standard variant
    // has been built (buildClaimPayload is not inside its own try). Claiming nothing was
    // built could talk a finder out of a signed tx that does exist, so the wording
    // states only what is certain, that nothing usable reached this banner.
    setBanner(
      `HIT! priv=0x${hex} for ${addr}, but the automatic claim pipeline failed: ` +
      `${e.message}. It did not produce a usable signed transaction, so the prize is ` +
      `claimable from this key alone. ${manualClaimWarning} ${keyNote}`, true);
    console.error("claim build failed:", e);
    return;
  }

  const { variants, tier1, relay, queued, queueEntry, destination } = result;

  // Surface the signed hexes too (the key was logged + persisted on entry).
  console.log("standard tx:", variants.standard.txid, variants.standard.hex);
  if (variants.shield) console.log("shield tx:", variants.shield.txid, variants.shield.hex);
  setTxStatus(`TX ${variants.standard.txid.slice(0, 16)}…`, variants.standard.hex);
  showPayoutTransaction(variants.standard.txid, variants.standard.hex, {
    title: "Payout transaction",
    note: "This is the signed transaction the app built for the hit.",
    userAddress: destination,
    devAddress: DEFAULT_PAYOUT_ADDRESS,
  });

  const payoutLine = fellBackToDev
    ? `No payout address was set — the prize goes to the developer (${destination}).`
    : `${variants.standard.userAmount.toLocaleString()} sats → ${destination}.`;

  // Offline: persist the queue entry; the auto-drain relays it on reconnect.
  if (queued && queueEntry) {
    enqueueClaim(queueEntry);
    setTxStatus(`TX ${variants.standard.txid.slice(0, 16)}…`, variants.standard.hex);
    setBanner(
      `HIT! priv=0x${hex}. TX built and signed but you're OFFLINE — queued to relay to the ` +
      `developer when connectivity returns. Once you are back online you can also submit it ` +
      `yourself PRIVATELY via slipstream.mara.com. Do NOT paste this into a public explorer ` +
      `or node. ${keyNote}\n\nStandard tx hex (also saved in this browser):\n\n${variants.standard.hex}`, true);
    return;
  }

  // Three outcomes, not two. relay.attempted is false only when the gift-wrap itself
  // could not be built (nostr-tools is fetched on demand and the fetch can fail), and
  // that must not read as a failed claim: it is the developer's backup copy, and
  // whether a pool accepted the tx is reported separately below.
  const relayNote = relay.anyAccepted
    ? "backup copy relayed to the developer"
    : relay.attempted
      ? "developer relay did not confirm"
      : "the developer's backup copy could not be built, which does not affect this claim";

  // Which private pools took it. tier1.ok is "at least one", so name them.
  const pools = tier1.attempted
    ? [tier1.shield?.ok ? `Rebar Shield (${tier1.shield.txid})` : null,
       tier1.slipstream?.ok ? `MARA Slipstream (${tier1.slipstream.txid})` : null].filter(Boolean)
    : [];

  if (tier1.ok) {
    // Tier 1 succeeded: submitted privately via Rebar Shield. Still surface the
    // Slipstream-ready standard hex — Shield accepting a tx does not mean a pool
    // ever mines it (a dry run sat unconfirmed for 64 blocks after an accepted
    // submission, docs/claim-testing.md), and without the hex on screen the user
    // has no way to act on that.
    setBanner(
      `🎉 HIT! Submitted privately to ${pools.join(" and ")}; ${relayNote}. ${payoutLine}\n\n` +
      `priv=0x${hex}\n${keyNote}\n\n` +
      `If it has not confirmed within a few hours, submit it yourself PRIVATELY via ` +
      `slipstream.mara.com — do NOT paste it into a public explorer or node, or it will be ` +
      `front-run and stolen. Standard tx hex:\n\n${variants.standard.hex}`);
  } else {
    // Tier 3: automatic path did not confirm — instruct manual private submission.
    setBanner(
      `HIT! priv=0x${hex}. Automatic private submission did not confirm ` +
      `(${tier1.error || tier1.reason || "unknown"}); ${relayNote}. SUBMIT IT YOURSELF ` +
      `PRIVATELY via slipstream.mara.com — do NOT paste it into a public explorer or node, ` +
      `or it will be front-run and stolen. ${keyNote}\n\n` +
      `Standard tx hex:\n\n${variants.standard.hex}`, true);
  }

  try {
    alert(
      `Bitcoin Puzzle solved!\n\n` +
      `Private key (hex):\n0x${hex}\n\n` +
      `Standard tx: ${variants.standard.txid}\n` +
      // Name the pool(s) that actually took it. Hardcoding "Rebar Shield" here was
      // wrong once Slipstream became a parallel tier: either pool alone satisfies
      // tier1.ok, so a Slipstream-only success used to be announced as a Shield one.
      (tier1.ok
        ? `Submitted privately to ${pools.join(" and ")}\n` +
          `If it does not confirm, submit the standard tx hex (on the page) via ` +
          `slipstream.mara.com, never a public explorer\n`
        : `NOT auto-submitted — submit via slipstream.mara.com, never a public explorer\n`) +
      `Your payout: ${variants.standard.userAmount.toLocaleString()} sats`);
  } catch {}
};

// Run the capability check (WGSL self-tests). The #tests section stays hidden
// while the run is in progress; it's only revealed if something fails. The
// Start button label is repurposed as the visible "we're working" indicator.
// Returns true on full pass.
//
// `includeDiagnostics` controls whether the off-path checks run at all. The automatic
// preflight leaves them OUT: they cannot affect a search, and on an RX 7800 XT one of them
// burns the full 25 s timeout and may leave the driver unhappy, so running them only to
// ignore the result is the worst of both. The manual "Run tests" button passes true, which
// keeps them available for exactly the driver-bug diagnosis they are good at.
const runCapabilityCheck = async ({ includeDiagnostics = false } = {}) => {
  const section = $("tests");
  // The progress bar now sits next to the (disabled) Start button; while the
  // check runs we show only that. The #tests detail panel (heading + results
  // table) stays hidden and is revealed only on failure or cancel.
  $("result-banner").hidden = true;   // clear any prior cancelled/failed banner from an earlier run
  $("tests-blurb").hidden = true;
  $("test-results").hidden = true;
  $("run-tests").hidden = true;
  section.hidden = true;
  $("tests-progress").hidden = false;

  // Let the user abort a bogged-down check and regain control of their system.
  const abort = new AbortController();
  const cancelBtn = $("cancel-tests");
  cancelBtn.hidden = false;
  cancelBtn.disabled = false;
  const onCancel = () => { cancelBtn.disabled = true; abort.abort(); };
  cancelBtn.addEventListener("click", onCancel);

  const startBtn = $("start-search");
  const prevLabel = startBtn.textContent;
  startBtn.disabled = true;
  startBtn.textContent = "Checking capability of your processor…";

  // Get a live device BEFORE running anything. A device lost since the last check used to make
  // every test throw, so "Re-check GPU" reported broken hardware when the only thing wrong was
  // that Safari had reclaimed an idle device. Failing here is a genuine "cannot get a GPU" and is
  // reported as such rather than as a maths failure.
  let reacquired = false;
  try {
    const got = await ensureDevice();
    reacquired = got.reacquired;
    if (got.adapter) adapterRef = got.adapter;   // fingerprint must describe the CURRENT adapter
  } catch (e) {
    cancelBtn.removeEventListener("click", onCancel);
    cancelBtn.hidden = true;
    startBtn.textContent = prevLabel;
    $("tests-progress").hidden = true;
    setGpuStatus(GPU_STATUS_NO_WEBGPU);
    $("gpu-status").hidden = false;
    setGpuInfo(describeWebGPUFailure(e.message));
    setBanner(`Could not get a WebGPU device for the capability check: ${e.message}`, true);
    return false;
  }

  let pass = 0, fail = 0, blockingFail = 0, diagnosticFail = 0, aborted = false, lastStarted = null, lastFailure = null;
  try {
    ({ pass, fail, blockingFail, diagnosticFail, aborted, lastStarted, lastFailure } =
      await runAllTests(abort.signal, { includeDiagnostics }));
  } finally {
    cancelBtn.removeEventListener("click", onCancel);
    cancelBtn.hidden = true;
    startBtn.textContent = prevLabel;
    $("tests-progress").hidden = true;
  }

  if (aborted) {
    // Cancelled by the user — not a pass, not a hardware failure. Let them retry.
    $("tests-heading").textContent = "Capability check cancelled";
    $("run-tests").hidden = false;
    section.hidden = false;
    setBanner(
      `Capability check cancelled — your system is free. Click "Re-run capability check" ` +
      `when ready; the search stays locked until the check passes.`,
      true
    );
    return false;
  }

  // Tolerate a STALE cached tests.js. A service worker or HTTP cache can serve an older
  // tests.js alongside this main.js, and the older one returns {pass, fail, aborted} with no
  // blockingFail. `undefined === 0` is false, so the gate then REFUSED A DEVICE ON WHICH EVERY
  // TEST HAD PASSED, and reported "Last test started: unknown" because the old runner never set
  // it. Reproduced exactly on Safari: a normal window failed while private browsing passed,
  // because private browsing has no cache to serve a stale module from.
  //
  // Falling back to `fail` is safe in the only direction that matters: it is the STRICTER
  // pre-change rule, so a mixed pair can over-block but never under-block. Second time this
  // session that a mixed old/new module pair has caused a confusing failure, so the rule is
  // worth stating: when a cross-module return shape changes, read it tolerantly.
  const blockingFailures = blockingFail ?? fail;
  if (blockingFail === undefined) {
    console.warn(
      "runAllTests() returned no blockingFail — a stale cached tests.js is being served against " +
      "this main.js. Falling back to the strict all-pass rule. A hard reload should fix it.",
    );
  }
  // Gate on BLOCKING failures only. A diagnostic failure means an off-path shader misbehaved
  // on this driver, which cannot affect a search, so refusing over it locks out working
  // hardware — confirmed on an RX 7800 XT and reproducible in two browsers.
  if (blockingFailures === 0 && pass > 0) {
    const fingerprint = await computeFingerprint(adapterRef);
    setStoredPreflight(fingerprint);
    if (diagnosticFail > 0) {
      // Worth telling them, and worth telling them it is harmless. Silence here would look
      // like we had not noticed; alarm would be wrong, because the production path passed.
      $("tests-blurb").hidden = false;
      $("test-results").hidden = false;
      $("run-tests").hidden = false;
      section.hidden = false;
      $("tests-heading").textContent =
        `Capability check passed (${diagnosticFail} off-path check${diagnosticFail === 1 ? "" : "s"} failed)`;
      setBanner(
        `Capability check PASSED. ${diagnosticFail} off-path diagnostic${diagnosticFail === 1 ? "" : "s"} ` +
        `failed on this driver; the search does not use ${diagnosticFail === 1 ? "it" : "them"}, so it is ` +
        `cleared to run. Details in the test panel.`,
        true
      );
    } else {
      section.hidden = true;   // clean pass — return to the clean state; search proceeds
    }
    $("start-hint").hidden = true;   // the "enabled once the check passes" hint is now stale
    return true;
  }

  // Blocking failure: surface the section so the user can see which tests failed.
  $("tests-heading").textContent = `Capability check failed (${pass} pass, ${blockingFailures} blocking fail)`;
  $("tests-blurb").hidden = false;
  $("test-results").hidden = false;
  $("run-tests").hidden = false;
  section.hidden = false;
  // Name the adapter in the refusal. Every refusal report so far has cost a round trip to
  // establish which GPU was actually tested, and on hybrid-graphics machines the answer is
  // often the iGPU rather than the card the user has in mind.
  const info = adapterRef?.info || {};
  const adapterLine = info.description
    || [...new Set([info.vendor, info.architecture].filter(Boolean))].join(" · ")
    || "unknown";
  setGpuInfo(
    `GPU: ${adapterLine} · ${browserName() || "unknown browser"}\n` +
    `Failed test: ${lastStarted || (() => { try { return sessionStorage.getItem("puzzlecrack.lastStartedTest") || "none, it failed before any test ran"; } catch { return "unknown"; } })()}\n` +
    // The reason line is the most useful thing on this panel and it used to live only in the
    // results table, which is below the fold. Three reports arrived saying "it timed out" with
    // no way to tell a stuck compile from a stuck dispatch. Now it is the first thing they see.
    `Reason: ${lastFailure || "unknown"}`
  );
  setGpuStatus(deviceLostInfo() ? GPU_STATUS_DEVICE_LOST : GPU_STATUS_CHECK_FAILED);
  $("gpu-status").hidden = false;
  // A lost device is a driver crash, not broken maths, and saying so matters: the two need
  // completely different responses from the user. Updating the driver or closing whatever else
  // is hammering the GPU can fix the first and will never fix the second.
  const lost = deviceLostInfo();
  // If we had to re-acquire the device to run at all, say so. A driver that drops devices and
  // then fails the checks is a different story from one that simply computes wrong answers, and
  // the user can act on the first.
  const lostNote = reacquired
    ? ` The previous GPU device had been lost, so a fresh one was acquired for this check.`
    : ``;
  setBanner(
    lost
      ? `GPU DRIVER CRASHED during the capability check on ${adapterLine} (${lost.reason}). ` +
        `This is a driver or system fault rather than broken math. Reloading may work; so may ` +
        `updating the GPU driver or closing other GPU-heavy apps. See test panel.`
      : `Capability check FAILED (${pass} pass, ${blockingFailures} blocking fail) on ${adapterLine}.` +
        lostNote +
        ` Math the search depends on is broken here, so it will not run. See test panel.`,
    true
  );
  return false;
};

// Defensive double-check from the Start handler. Cheap when the fingerprint is
// already cached (the auto-run on load will normally have populated it).
const ensurePreflightPassed = async () => {
  const fingerprint = await computeFingerprint(adapterRef);
  const stored = getStoredPreflight();
  if (preflightIsValid(stored, fingerprint)) return true;
  $("tests-heading").textContent = "Checking capability of your processor…";
  return runCapabilityCheck({ includeDiagnostics: false });
};

const wireSearch = () => {
  const startBtn = $("start-search");
  const stopBtn  = $("stop-search");

  const start = async () => {
    const rangeStart = RANGE_START;
    const rangeEnd   = RANGE_END;
    const targetAddress = TARGET_ADDRESS;
    // The payout address is NOT required to search — the GPU loop never uses
    // it. It's only needed to build the claim tx on a (astronomically rare)
    // hit, so we don't block Start on it. The hit handler re-reads the field
    // and, if it's still missing/invalid, pauses to collect one. The recovered
    // key is always logged first, so the prize is never lost.
    $("user-payout-address").removeAttribute("aria-invalid");
    startBtn.disabled = true;
    stopBtn.disabled  = true;     // re-enabled after preflight finishes

    // Preflight: silent if fingerprint matches; visible run otherwise.
    const ok = await ensurePreflightPassed();
    if (!ok) {
      startBtn.disabled = false;
      return;
    }

    if (!coordinator) {
      coordinator = new SearchCoordinator();
      try {
        await coordinator.setup();
      } catch (e) {
        setBanner("Search shader setup failed: " + e.message, true);
        coordinator = null;
        startBtn.disabled = false;
        return;
      }
    }

    stopBtn.disabled = false;
    $("result-banner").hidden = true;
    const idleLabel = startBtn.textContent;
    startBtn.textContent = "Searching…";
    startBtn.classList.add("searching");

    // Successful use: search is running and the user provided a valid payout
    // address. Don't surface the install CTA the instant cracking starts — it
    // reads as too sudden. The first such start arms it (revealed when the user
    // next returns to the tab); a second start reveals it right away.
    if (isLikelyBitcoinAddress($("user-payout-address").value.trim())) {
      if (installCtaArmed) {
        maybeShowInstallCTA();
      } else {
        installCtaArmed = true;
        document.addEventListener("visibilitychange", onVisibleShowInstallCTA);
      }
    }

    const startTs = performance.now();
    try {
      await coordinator.start({
        rangeStart, rangeEnd, targetAddress,
        onProgress: ({ totalChecked, rate, dispatchKeys, chunkPriv, chunkSpan }) => {
          // rate is null until the first dispatch lands in the rolling window.
          $("m-rate").textContent = rate === null ? "—" : fmtBig(Math.floor(rate));
          $("m-total").textContent = fmtBig(totalChecked);
          $("m-range").textContent = "0x" + chunkPriv.toString(16) + "  +" + chunkSpan;
          $("m-eta").textContent = formatEta(rangeEnd - rangeStart, rate);
          $("m-dispatch").textContent = fmt(dispatchKeys);
          noteDispatch();
        },
        onHit: async ({ priv, addr, verified }) => {
          if (!verified) {
            setBanner(`Spurious hit reported by GPU but CPU verification failed for priv=0x${priv.toString(16)}; ignoring.`, true);
            return;
          }
          const hex = priv.toString(16).padStart(64, "0");
          // Always log the privkey first, before anything else can fail.
          console.log("=== PRIZE PRIVATE KEY (save this immediately) ===");
          console.log("priv hex:", hex);
          console.log("address:", addr);

          // Re-read the field at hit time: the user may have entered a payout
          // address after starting. If still empty/invalid, runClaim falls back
          // to the developer address so the prize is never lost.
          const payout = $("user-payout-address").value.trim();
          await runClaim({ priv, hex, addr, userPayoutAddress: payout });
        },
        onDeviceLost: (info) => {
          if (info?.recovering) {
            setBanner(
              `GPU watchdog interrupted an over-long dispatch. Auto-reducing to ` +
              `${info.keysPerDispatch.toLocaleString()} keys/dispatch and recovering ` +
              `(attempt ${info.attempt}/${4})…`, true);
          } else {
            setBanner(
              `WebGPU device lost and could not recover` +
              (info?.keysPerDispatch ? ` even at ${info.keysPerDispatch.toLocaleString()} keys/dispatch` : "") +
              `. This GPU's watchdog may be too aggressive for this workload. Reload to try again.`, true);
          }
        },
      });
    } finally {
      startBtn.disabled = false;
      stopBtn.disabled  = true;
      startBtn.textContent = idleLabel;
      startBtn.classList.remove("searching");
      const elapsed = ((performance.now() - startTs) / 1000).toFixed(1);
      console.log(`search loop ended after ${elapsed}s`);
    }
  };

  startBtn.addEventListener("click", start);
  stopBtn.addEventListener("click", () => coordinator?.stop());

  // Share section: an always-visible "Copy link" (universal, clipboard) plus a
  // native "Share" button shown only where navigator.share exists. Both build
  // the same live link and validate the payout first; feedback is inline (the
  // result banner is reserved for hits/errors). The link updates live as the
  // payout address or autostart toggle change.
  const shareUrlField = $("share-url");
  const setShareFeedback = (msg) => { const el = $("share-feedback"); if (el) el.textContent = msg; };
  // Validate the payout + refresh the link; returns the URL, or null if invalid.
  const shareURLOrWarn = () => {
    const payInput = $("user-payout-address");
    const pay = payInput.value.trim();
    if (pay && !isLikelyBitcoinAddress(pay)) {
      payInput.setAttribute("aria-invalid", "true");
      payInput.focus();
      setShareFeedback("That payout address looks invalid. Fix it before sharing.");
      return null;
    }
    payInput.removeAttribute("aria-invalid");
    refreshShareURL();
    return shareUrlField.value;
  };

  $("user-payout-address").addEventListener("input", () => {
    // Clear a stale invalid flag as soon as the user edits, so the red
    // border/text doesn't stick after they start fixing the address.
    $("user-payout-address").removeAttribute("aria-invalid");
    // Persist what the user types (share-link prefills assign .value and so
    // never fire this — only the device owner's own typing updates storage).
    const typed = $("user-payout-address").value.trim();
    try {
      if (typed) localStorage.setItem(PAYOUT_KEY, typed);
      else localStorage.removeItem(PAYOUT_KEY);
    } catch { /* storage unavailable (private mode) — field still works */ }
    refreshShareURL();
  });
  $("share-autostart").addEventListener("change", refreshShareURL);
  shareUrlField.addEventListener("focus", () => shareUrlField.select());
  shareUrlField.addEventListener("click", () => shareUrlField.select());

  // Copy link — universal, always shown.
  $("copy-share-url").addEventListener("click", async () => {
    const url = shareURLOrWarn();
    if (url == null) return;
    try {
      await navigator.clipboard.writeText(url);
      setShareFeedback("Link copied to clipboard.");
    } catch {
      shareUrlField.focus();
      shareUrlField.select();
      setShareFeedback("Press Ctrl/Cmd+C to copy the selected link.");
    }
  });

  // Native Share — only wired and revealed where the share sheet exists.
  const shareBtn = $("share-link");
  if (navigator.share) {
    shareBtn.hidden = false;
    shareBtn.addEventListener("click", async () => {
      const url = shareURLOrWarn();
      if (url == null) return;
      try {
        await navigator.share({ url, title: "WebGPU Bitcoin Puzzle Solver" });
        setShareFeedback("Shared.");
      } catch (e) {
        if (e?.name !== "AbortError") setShareFeedback("Share failed. Use Copy link instead.");
      }
    });
  }

  // Returns the start handler so the autostart path can fire it.
  return start;
};

// ---------------------------------------------------------------------------
// Tab-visibility notice
//
// Two signals with different jobs, per docs/tab-visibility-notice.md:
//   visibility  triggers the tab-strip change (title + favicon), immediately.
//   dispatch gap measures what the pause actually cost, on return.
//
// The gap is the gate for the in-page line rather than visibilitychange alone,
// because a screen lock or an occluded window may never report as hidden but
// still stalls dispatches. Requiring BOTH a hidden period and a long gap keeps
// a device-loss recovery pause (also a long gap) from triggering it.
// ---------------------------------------------------------------------------

// The live icon at reduced opacity. Geometry and colours are byte-identical to
// the <link rel="icon"> in index.html: in a crowded tab strip the favicon is
// how someone finds this tab again, and they scan for the red before the shape,
// so fading it reads as inactive without removing the thing being scanned for.
const PAUSED_ICON = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<g opacity="0.45">' +
  '<rect width="100" height="100" rx="22" fill="#db3b26"/>' +
  '<rect x="18" y="30" width="56" height="48" rx="10" fill="#e7e1d2"/>' +
  '<circle cx="46" cy="30" r="11" fill="#e7e1d2"/>' +
  '<circle cx="74" cy="54" r="10" fill="#db3b26"/>' +
  '<text x="42" y="58" font-family="Arial,sans-serif" font-weight="bold" ' +
  'font-size="34" fill="#db3b26" text-anchor="middle" ' +
  'dominant-baseline="central">\u20bf</text>' +
  '</g></svg>'
);

let tabNoticeShown = false;   // once per session
let sawHidden = false;        // tab went hidden since the last dispatch
let lastDispatchAt = 0;       // performance.now() of the last progress report
let stashedTitle = "";
let stashedIcons = [];
let pausedIconLink = null;

// A search is running exactly when Stop is available. Read from the DOM rather
// than tracked separately so this cannot drift out of sync with the real state.
const isSearching = () => {
  const btn = $("stop-search");
  return !!btn && !btn.disabled;
};

// Swap every icon link, not just one: index.html ships an SVG, an .ico and a
// PNG, and the browser picks. Detaching them all and appending a single paused
// link is the only way to be sure the tab strip shows the paused mark.
const setPausedIcon = (on) => {
  if (on) {
    if (pausedIconLink) return;
    stashedIcons = Array.from(document.head.querySelectorAll('link[rel~="icon"]'));
    stashedIcons.forEach((link) => link.remove());
    pausedIconLink = document.createElement("link");
    pausedIconLink.rel = "icon";
    pausedIconLink.type = "image/svg+xml";
    pausedIconLink.href = PAUSED_ICON;
    document.head.appendChild(pausedIconLink);
  } else {
    if (pausedIconLink) { pausedIconLink.remove(); pausedIconLink = null; }
    stashedIcons.forEach((link) => document.head.appendChild(link));
    stashedIcons = [];
  }
};

// Rounded on purpose. The user wants to know why their total did not move, not
// the pause to the second, and precision here reads as surveillance.
const formatPause = (ms) => {
  const mins = Math.round(ms / 60_000);
  if (mins >= 120) return `about ${Math.round(mins / 60)} hours`;
  if (mins >= 60) return "about an hour";
  if (mins >= 2) return `about ${mins} minutes`;
  return "about a minute";
};

const showTabPauseNotice = (ms) => {
  if (tabNoticeShown) return;
  const el = $("tab-pause-notice");
  if (!el) return;
  try { if (localStorage.getItem(TAB_NOTICE_DISMISSED_KEY)) return; }
  catch { /* storage off — show it */ }

  const text = $("tab-pause-text");
  if (text) {
    text.textContent = Number.isFinite(ms)
      ? `Running again. The search paused for ${formatPause(ms)} while this tab ` +
        `was in the background. Nothing was lost.`
      : `Running again. The search paused while this tab was in the background. ` +
        `Nothing was lost.`;
  }
  el.hidden = false;
  tabNoticeShown = true;
};

// Called from onProgress. Every completed dispatch reports the wall-clock gap
// since the previous one; a long gap that coincides with a hidden period is a
// background pause.
const noteDispatch = () => {
  // Guarded because this runs inside onProgress, which the dispatch loop calls
  // on every progress report. An exception here would propagate into that loop
  // and could stop a running search. The search is the one thing on this page
  // that must not break, and nothing in a cosmetic notice is worth that risk.
  try {
    const now = performance.now();
    const gap = lastDispatchAt ? now - lastDispatchAt : 0;
    lastDispatchAt = now;
    if (sawHidden && gap >= TAB_PAUSE_MIN_MS) showTabPauseNotice(gap);
    if (document.visibilityState === "visible") sawHidden = false;
  } catch (e) {
    console.warn("tab-pause notice failed, search unaffected:", e);
  }
};

const wireTabVisibilityNotice = () => {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      // Only claim "Paused" when something was actually running.
      if (!isSearching()) return;
      sawHidden = true;
      if (!stashedTitle) stashedTitle = document.title;
      document.title = PAUSED_TITLE;
      setPausedIcon(true);
    } else {
      if (stashedTitle) { document.title = stashedTitle; stashedTitle = ""; }
      setPausedIcon(false);
    }
  });

  const dismiss = $("tab-pause-dismiss");
  if (dismiss) {
    dismiss.addEventListener("click", () => {
      const el = $("tab-pause-notice");
      if (el) el.hidden = true;
      try { localStorage.setItem(TAB_NOTICE_DISMISSED_KEY, "1"); }
      catch { /* storage off — dismissal just isn't remembered */ }
    });
  }
};

const main = async () => {
  // Register the service worker so the app shell + esm.sh modules are cached
  // for offline use. First visit must be online to populate the cache.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW registration failed:", e));
    // Refresh the build badge once the SW is active (the cache exists by then).
    navigator.serviceWorker.ready.then(showBuildVersion).catch(() => {});
  }
  showBuildVersion();

  // Capture (and suppress) the browser's install prompt now, so it's ready if
  // the user reaches a successful search start. Must be registered early — the
  // beforeinstallprompt event can fire before init finishes.
  wireInstallPrompt();

  // Tab-visibility notice. Registered early and always: the title and favicon
  // swap has to be armed before any search starts.
  wireTabVisibilityNotice();

  // Drain queued claims as soon as we're online (now or later). A hit is a
  // once-in-a-never event, so we don't surface live network/queue status — the
  // auto-drain quietly submits the queued tx to Shield's private RPC and relays
  // the encrypted copy to the developer over Nostr when connectivity returns
  // (neither is a public-mempool broadcast).
  // Names whichever private pool(s) took the queued tx. `s.shield` / `s.slipstream`
  // are the per-pool results; `s.ok` is "at least one accepted".
  const submitNote = (s) => {
    if (!s) return "";
    if (s.alreadySubmitted) return " Already submitted earlier.";
    if (s.ok) {
      const pools = [s.shield?.ok ? "Rebar Shield" : null, s.slipstream?.ok ? "MARA Slipstream" : null]
        .filter(Boolean).join(" and ");
      return ` Submitted privately to ${pools || "a private pool"} (txid ${s.txid}).`;
    }
    return ` Both private submissions failed (${s.error}). Submit the tx hex yourself privately via slipstream.mara.com.`;
  };
  wireAutoDrain((result) => {
    for (const b of result.relayed) {
      const accepted = b.relayResult.perRelay.filter((r) => r.ok).length;
      setBanner(`Queued claim ${b.txid} relayed to the developer (${accepted} relay${accepted === 1 ? "" : "s"} accepted); ${b.userAmount.toLocaleString()} sats → ${b.userAddress}.${submitNote(b.submit)}`);
    }
    for (const f of result.failed) {
      setBanner(`Queued claim ${f.txid} still not relayed: ${f.error}. Will retry on next online transition.${submitNote(f.submit)}`, true);
    }
  });

  try {
    const { adapter, device } = await initWebGPU();
    adapterRef = adapter;
    // Surface which adapter is actually running: on dual-GPU machines the
    // high-performance hint can lose to the display-attached iGPU, and a rate
    // report is meaningless without knowing which silicon produced it.
    //
    // The browser is named too, because it matters as much as the silicon here
    // (Firefox measured 44% of Chromium on the same M3 Pro) and because Firefox
    // reports no vendor or architecture, which used to leave this tile saying only
    // "unknown". Keeping "unknown" alongside the browser is deliberate: it reports
    // that the GPU is unidentified AND explains why in the same breath.
    // Deduplicated because Safari reports vendor and architecture both as "apple",
    // and "apple · apple" reads like a bug. The kangaroo demo already did this; the
    // main page never did, and adding a third segment made it read worse still.
    const info = adapter.info || {};
    const gpuPart = info.description ||
      [...new Set([info.vendor, info.architecture].filter(Boolean))].join(" · ");
    $("m-gpu").textContent =
      [gpuPart || "unknown", browserName()].filter(Boolean).join(" · ");
    console.log("WebGPU adapter ready.", {
      features: [...adapter.features],
      maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
    });
  } catch (e) {
    setGpuStatus(GPU_STATUS_NO_WEBGPU);
    $("gpu-status").hidden = false;
    setGpuInfo(describeWebGPUFailure(e.message));
    return;
  }

  const startHandler = wireSearch();
  $("start-search").disabled = true;     // re-enabled after capability check passes

  // Pre-fill the form from share params and populate the copyable link NOW —
  // before the (possibly multi-second) capability check — so the share UI is
  // usable immediately. All share values were strictly validated by
  // parseShareParams (regex character-class + length), so we only see safe
  // strings; we assign via .value/.checked, never .innerHTML.
  // Restore the last-typed payout address so a returning visitor can press
  // Start without re-entering it. An explicit ?pay= share param wins for this
  // load (the share mechanic), but doesn't overwrite the stored value.
  try {
    const savedPay = localStorage.getItem(PAYOUT_KEY);
    $("user-payout-address").value = savedPay || DEFAULT_PAYOUT_ADDRESS;
  } catch {
    $("user-payout-address").value = DEFAULT_PAYOUT_ADDRESS;
  }
  const share = parseShareParams();
  if (share.pay) $("user-payout-address").value = share.pay;
  if (share.autostart) $("share-autostart").checked = true;
  refreshShareURL();
  showPayoutTransaction(
    MOCK_PAYOUT_TRANSACTION.txid,
    MOCK_PAYOUT_TRANSACTION.hex,
    {
      title: "Mock payout transaction",
      note: "Raw Bitcoin transaction hex preview.",
      userAddress: $("user-payout-address").value.trim() || DEFAULT_PAYOUT_ADDRESS,
      devAddress: DEFAULT_PAYOUT_ADDRESS,
      format: "hex",
    }
  );

  // Capability check: auto-run inline on first visit (or after code/driver
  // change). When cached for this (adapter, shader-source) combo, the section
  // stays hidden and Start is enabled immediately.
  const fingerprint = await computeFingerprint(adapterRef);
  const stored = getStoredPreflight();
  if (preflightIsValid(stored, fingerprint)) {
    console.log(`capability check cached, last passed ${stored.passedAt}`);
    $("start-search").disabled = false;
    $("start-hint").hidden = true;   // already passed (cached) — the hint is stale
  } else {
    $("tests-heading").textContent = "Checking capability of your processor…";
    const ok = await runCapabilityCheck({ includeDiagnostics: false });
    if (ok) $("start-search").disabled = false;
  }

  // Manual re-check from the footer link and the in-section button.
  const triggerRecheck = async (e) => {
    if (e) e.preventDefault();
    $("tests-heading").textContent = "Re-checking capability of your processor…";
    $("start-search").disabled = true;
    const ok = await runCapabilityCheck({ includeDiagnostics: true });
    if (ok) $("start-search").disabled = false;
  };
  $("run-tests").addEventListener("click", triggerRecheck);
  $("recheck-capability").addEventListener("click", triggerRecheck);

  // Parse share params and pre-fill the form. All values were strictly
  // validated by parseShareParams (regex character-class + length) before
  // returning, so we only ever see safe strings here. We assign via .value
  // (the input element doesn't interpret HTML), never .innerHTML.
  // Populate the read-only target + range display from config.js.
  $("cfg-target").textContent = TARGET_ADDRESS;
  $("cfg-target").href = `https://mempool.space/address/${TARGET_ADDRESS}`;
  $("cfg-range").textContent  =
    "0x" + RANGE_START.toString(16) + "  →  0x" + RANGE_END.toString(16);

  // Autostart: fire the start handler once the WebGPU adapter is ready.
  // The preflight (test-suite gate) is owned by startHandler itself; if tests
  // need to run they will, blocking until they pass.
  if (share.autostart && share.pay) {
    setBanner(`Autostart requested. Payout address: ${share.pay}.`);
    // Defer one tick so the UI paints the banner before the modal blocking
    // alert() that may pop on hit.
    setTimeout(() => startHandler(), 50);
  }
};

main();
