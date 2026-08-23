// Persistent queue for a hit that could not be submitted yet (offline at hit
// time). Survives page reload. Auto-drains on the `online` event and on startup
// if there's already connectivity. Draining does two things per entry:
//   1. submits the queued standard-variant hex to Rebar Shield's private RPC,
//   2. publishes the pre-built, encrypted Nostr gift-wrap to the relays (Tier 2).
// Neither is a public-mempool broadcast. Entries stay queued until a relay
// accepts, and retry on the next online transition. See docs/claim-privacy.md.
//
// A queue entry carries the signed standard-variant hex and the gift-wrap event
// (built at hit time; wrapping needs no private key and no network), so the
// relay survives reload without the queue entry itself holding the private key.
//
// This module also owns `saveRecoveredKey` (below), which DOES persist the
// recovered key on-device, separately from the queue. Deliberate: the key is the
// one irreplaceable part of a hit, and losing it to a closed tab would be worse
// than storing it locally.

import { publishClaim } from "./claim-relay.js";
import { submitToShield } from "./shield.js";
import { submitToSlipstream } from "./slipstream.js";

const QUEUE_KEY = "puzzlecrack.pendingClaims";
const KEYS_KEY  = "puzzlecrack.recoveredKeys";

const load = () => {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); }
  catch { return []; }
};
const save = (queue) => localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));

// Persist the recovered private key the moment it is found, before anything that
// could fail (no UTXO snapshot, claim build error, a closed tab, a crash). A hit
// is a once-in-the-universe event and the key is the only irreplaceable part of
// it: everything else can be rebuilt from it. Appends rather than overwrites so a
// second hit cannot clobber the first.
//
// This is on-device only — localStorage never goes over the network, and the
// claim modules are handed the key directly anyway, so storing it grants no code
// access it did not already have. Returns false if storage is unavailable
// (private mode, quota), in which case the console and banner remain the record.
export const saveRecoveredKey = (entry) => {
  try {
    const all = JSON.parse(localStorage.getItem(KEYS_KEY) || "[]");
    all.push({ ...entry, savedAt: new Date().toISOString() });
    localStorage.setItem(KEYS_KEY, JSON.stringify(all));
    return true;
  } catch { return false; }
};

export const getRecoveredKeys = () => {
  try { return JSON.parse(localStorage.getItem(KEYS_KEY) || "[]"); }
  catch { return []; }
};

export const enqueue = (entry) => {
  const queue = load();
  queue.push({ ...entry, enqueuedAt: new Date().toISOString() });
  save(queue);
};

export const getPending = () => load();

// Submit a queued entry's standard-variant hex to BOTH private pools. An offline hit
// never gets a Tier-1 attempt at hit time (the Shield fee output needs the
// address and feerate from /info, which needs the network), so without this the
// user's own claim would never be submitted automatically at all and only the
// developer's Nostr copy would go out. The standard variant carries a normal
// on-chain fee, so it needs no rebuild and no private key: the queued hex goes
// straight to the RPC. Submitted at most once — `shieldSubmitted` is persisted so
// later drains (which keep retrying the relay) do not resubmit it.
const submitQueuedToPools = async (entry, submitShield, submitSlipstream) => {
  if (entry.shieldSubmitted) return { ok: true, alreadySubmitted: true };
  if (!entry.standardHex) return { ok: false, error: "queue entry has no standard tx hex" };
  // Both pools, in parallel, same standard hex. Neither can reject the pair.
  const [a, b] = await Promise.all([
    submitShield(entry.standardHex).then(r => ({ ok: true, txid: r.txid }), e => ({ ok: false, error: e.message || String(e) })),
    submitSlipstream(entry.standardHex).then(r => ({ ok: true, txid: r.txid }), e => ({ ok: false, error: e.message || String(e) })),
  ]);
  if (a.ok || b.ok) {
    return { ok: true, txid: a.ok ? a.txid : b.txid, shield: a, slipstream: b };
  }
  return { ok: false, error: `shield: ${a.error}; slipstream: ${b.error}`, shield: a, slipstream: b };
};

// Deps are injectable so this is testable without touching the network.
export const drainOnce = async ({
  publish = publishClaim,
  submitShield = submitToShield,
  submitSlipstream = submitToSlipstream,
} = {}) => {
  const queue = load();
  if (queue.length === 0) return { relayed: [], failed: [], pending: 0 };

  const relayed = [];
  const failed = [];
  const shieldAccepted = new Set();
  for (const entry of queue) {
    // Shield first: it is the user's actual claim, the relay is the backup copy.
    const submit = await submitQueuedToPools(entry, submitShield, submitSlipstream);
    if (submit.ok && !submit.alreadySubmitted) shieldAccepted.add(entry.txid);

    if (!entry.wrap) {
      failed.push({ ...entry, submit, error: "queue entry has no gift-wrap event" });
      continue;
    }
    try {
      const relayResult = await publish(entry.wrap);
      if (relayResult.anyAccepted) relayed.push({ ...entry, submit, relayResult });
      else failed.push({ ...entry, submit, error: "no relay accepted the claim", relayResult });
    } catch (e) {
      failed.push({ ...entry, submit, error: e.message || String(e) });
    }
  }
  // Remove only the successfully-relayed entries so failures retry next time,
  // carrying forward that Shield already has the tx.
  const stillPending = load()
    .filter((e) => !relayed.find((b) => b.txid === e.txid))
    .map((e) => (shieldAccepted.has(e.txid) ? { ...e, shieldSubmitted: true } : e));
  save(stillPending);
  return { relayed, failed, pending: stillPending.length };
};

// Wire `online` and startup auto-drain. Pass an `onResult` callback that
// receives every drain's result for UI surfacing. Returns a `triggerNow`
// function the caller can invoke manually (e.g. from a "retry now" button).
export const wireAutoDrain = (onResult) => {
  const tryDrain = async () => {
    if (!navigator.onLine) return;
    if (load().length === 0) return;
    const result = await drainOnce();
    onResult?.(result);
  };
  window.addEventListener("online", tryDrain);
  // Run on startup if there's already a queue and we're online.
  if (typeof requestIdleCallback === "function") requestIdleCallback(tryDrain);
  else setTimeout(tryDrain, 100);
  return tryDrain;
};
