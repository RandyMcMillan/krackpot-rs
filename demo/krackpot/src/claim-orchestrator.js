// Three-tier private claim orchestration. main.js owns the DOM/banners and the
// payout-address decision; this module decides what to build, submit, and relay,
// and returns a structured result to render. It NEVER broadcasts to the public
// mempool. Network + signing calls are injectable so the branching is testable.
//
// Loaded dynamically on a hit. Both third-party libraries are now genuinely
// hit-time-only: @scure/btc-signer via prize-claim.js, and nostr-tools via a cached
// dynamic import inside claim-relay.js. claim-relay.js is still reached by a static
// chain (main.js -> claim-queue -> here), but it no longer drags esm.sh with it, so
// the page loads no third-party code at all.
//
// Tiers:
//   1  browser submits privately to TWO pools IN PARALLEL (automatic):
//        1a Rebar Shield  <- the shield variant (0 on-chain fee + Shield fee output)
//        1b MARA Slipstream <- the standard variant (real 69 sat/vB; Slipstream
//           enforces a fee-rate floor, so the 0-fee shield variant cannot go here)
//      The two variants spend the same UTXOs and therefore CONFLICT. That is
//      intended: at most one can confirm, both pay the finder the same 6 BTC, and
//      two independent pools beat one. The 2026-07-27 dry run is the reason
//      (Shield accepted, then did not mine it for 64 blocks).
//   2  browser relays both variants (encrypted) to the developer over Nostr
//   3  UI concern (showManualFallback): only if BOTH 1a and 1b failed to send

import { buildSignedTx, buildShieldTx } from "./prize-claim.js";
import { fetchShieldInfo, pickShieldTier, submitToShield } from "./shield.js";
import { submitToSlipstream } from "./slipstream.js";
import { buildClaimPayload, giftWrapClaim, publishClaim } from "./claim-relay.js";

const POOL_DEADLINE_MS = 25000;
const WRAP_DEADLINE_MS = 13000;
const makeDeadline = (ms) => (promise, label) => Promise.race([
  promise,
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label}: no response after ${ms / 1000}s`)), ms)),
]);

const capError = (e) => String(e && e.message ? e.message : e).slice(0, 200);

export const orchestrateClaim = async (input, deps = {}) => {
  const {
    priv, privHex, addr, destination, fellBackToDev, utxos,
    online = (typeof navigator !== "undefined" ? navigator.onLine : true),
  } = input;
  const {
    buildStandard = buildSignedTx,
    buildShield   = buildShieldTx,
    getShieldInfo = fetchShieldInfo,
    chooseTier    = pickShieldTier,
    submitShield  = submitToShield,
    submitSlipstream = submitToSlipstream,
    buildPayload  = buildClaimPayload,
    wrap          = giftWrapClaim,
    publish       = publishClaim,
    now           = () => Math.floor(Date.now() / 1000),
    deadlineMs    = POOL_DEADLINE_MS,
    wrapDeadlineMs = WRAP_DEADLINE_MS,
  } = deps;

  const withDeadline = makeDeadline(deadlineMs);
  const withWrapDeadline = makeDeadline(wrapDeadlineMs);
  const ts = now();

  const standard = buildStandard({ privBigInt: priv, userAddress: destination, utxos });

  let shield = null;
  let tier1;

  if (online) {
    const shieldAttempt = (async () => {
      let info, tier;
      try {
        info = await withDeadline(getShieldInfo(), "shield /info");
        tier = chooseTier(info);
      } catch (e) {
        return { attempted: true, ok: false, error: `shield unavailable: ${capError(e)}` };
      }
      let built;
      try {
        built = buildShield({
          privBigInt: priv, userAddress: destination, utxos,
          shieldAddress: tier.address, shieldFeerateSatPerVb: tier.feerateSatPerVb,
        });
      } catch (e) {
        return { attempted: true, ok: false, error: `shield build failed: ${capError(e)}` };
      }
      try {
        const res = await withDeadline(submitShield(built.hex), "shield submit");
        return { attempted: true, ok: true, txid: res.txid, built };
      } catch (e) {
        return { attempted: true, ok: false, error: capError(e), built };
      }
    })();

    const slipstreamAttempt = (async () => {
      try {
        const res = await withDeadline(submitSlipstream(standard.hex), "slipstream submit");
        return { attempted: true, ok: true, txid: res.txid };
      } catch (e) {
        return { attempted: true, ok: false, error: capError(e) };
      }
    })();

    const [shieldRes, slipRes] = await Promise.all([shieldAttempt, slipstreamAttempt]);
    shield = shieldRes.built ?? null;
    const { built, ...shieldStatus } = shieldRes;

    tier1 = {
      attempted: true,
      ok: shieldStatus.ok || slipRes.ok,
      txid: shieldStatus.ok ? shieldStatus.txid : (slipRes.ok ? slipRes.txid : undefined),
      shield: shieldStatus,
      slipstream: slipRes,
    };
    if (!tier1.ok) {
      tier1.error = `shield: ${shieldStatus.error || "failed"}; slipstream: ${slipRes.error || "failed"}`;
    }
  } else {
    tier1 = { attempted: false, reason: "offline" };
  }

  const context = { puzzle: "71", target: addr, userAddress: destination, pubkeyHex: null, ts };
  const payload = buildPayload({ shield, standard, tier1, context });
  let wrapped = null;
  let wrapError = null;
  try {
    wrapped = await withWrapDeadline(wrap(payload, { createdAt: ts }), "gift-wrap");
  } catch (e) {
    wrapError = capError(e);
  }

  let relay = { attempted: false };
  let queued = false;
  if (wrapError) {
    relay = { attempted: false, error: `gift-wrap failed: ${wrapError}` };
    queued = !online;
  } else if (online) {
    try {
      const pub = await publish(wrapped);
      relay = { attempted: true, anyAccepted: pub.anyAccepted, perRelay: pub.perRelay, eventId: pub.eventId };
    } catch (e) {
      relay = { attempted: true, anyAccepted: false, error: e.message };
    }
  } else {
    queued = true;
  }

  const showManualFallback = !(tier1.attempted && tier1.ok);

  const queueEntry = queued
    ? {
        wrap: wrapped, txid: standard.txid, privHex, address: addr,
        userAddress: destination, standardHex: standard.hex,
        userAmount: standard.userAmount, devAmount: standard.devAmount,
      }
    : null;

  return {
    destination, fellBackToDev,
    variants: { standard, shield },
    tier1, relay, queued, queueEntry, showManualFallback,
    wrap: wrapped,
  };
};
