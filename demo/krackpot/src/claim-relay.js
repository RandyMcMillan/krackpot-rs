// Tier 2 of the private claim submission: relay the signed tx to the developer
// over Nostr, as a backup to the browser's own Tier-1 Rebar Shield submission.
//
// The payload carries MULTIPLE pre-signed tx variants, because the developer
// holds no private key and cannot build new ones:
//   - shield   : buildShieldTx output (3 outputs incl. Shield fee, 0 on-chain fee)
//   - standard : buildSignedTx output (normal on-chain fee; Slipstream / Braiins)
// plus a `tier1` status note saying whether the browser's own Rebar submission
// already succeeded. The private key is NEVER included.
//
// The payload is NIP-44 encrypted and NIP-59 gift-wrapped (kind 1059) to
// CLAIM_NPUB with a fresh throwaway sender key, then published to CLAIM_RELAYS.
// wss:// WebSocket connections are exempt from CORS, so this runs straight from
// the browser to any relay. See docs/claim-privacy.md.
//
// nostr-tools is loaded on demand, NOT at module scope. This file is reached by a
// static chain from main.js (main -> claim-queue -> here), so a top-level
// `import ... from "https://esm.sh/..."` made every visitor fetch third-party code
// before the page could run, which meant an esm.sh outage, DNS block or adblock
// rule took the whole page down. Nothing here is needed until a key is found.
//
// The specifier stays the top-level module (NOT a subpath) and byte-identical, for
// two reasons: the esm.sh test loader maps this exact pinned URL to local
// node_modules, and the service worker runtime-caches esm.sh by exact URL.
import { CLAIM_NPUB, CLAIM_RELAYS } from "./config.js";

// A blocked or dropped connection can leave a dynamic import PENDING rather than
// rejecting, and this load sits between a pool accepting the transaction and the hit
// banner that carries the key and the signed hex. So it gets its own deadline, and
// the cache is cleared on any failure so a later attempt can retry instead of
// awaiting a promise that already lost.
const NOSTR_LOAD_DEADLINE_MS = 10000;

let nostrToolsPromise;
const loadNostrTools = () => (nostrToolsPromise ??= (async () => {
  let timer;
  try {
    return await Promise.race([
      import("https://esm.sh/nostr-tools@2.24.1"),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`nostr-tools load: no response after ${NOSTR_LOAD_DEADLINE_MS / 1000}s`)),
          NOSTR_LOAD_DEADLINE_MS);
      }),
    ]);
  } catch (e) {
    // Clear on BOTH rejection and timeout. Leaving a lost promise cached would make
    // one transient failure permanent for the session.
    nostrToolsPromise = undefined;
    throw e;
  } finally {
    clearTimeout(timer);
  }
})());

export const PAYLOAD_VERSION = 1;

// Assemble the plaintext claim payload. Pure (no crypto, no network). `shield`
// and `standard` are the return objects from prize-claim.js (buildShieldTx /
// buildSignedTx); either may be null. `tier1` is the browser's own Rebar Shield
// attempt result: { attempted, ok, txid?, error? }. NEVER include the priv key.
//
// Inner payload JSON (stored as the rumor `content` before encryption):
//   {
//     "v": 1,
//     "puzzle": "71",
//     "target": "<target address>",
//     "userAddress": "<user payout address>",
//     "pubkeyHex": null,
//     "ts": 1724430000,
//     "tier1": { "attempted": true, "ok": false, "txid": "...", "error": "..." },
//     "note": "<human-readable summary>",
//     "variants": {
//       "shield": { "txid": "...", "hex": "...", "feeAddress": "...", "feeSats": 123n },
//       "standard": { "txid": "...", "hex": "...", "feeSats": 123n }
//     }
//   }
export const buildClaimPayload = ({ shield, standard, tier1, context } = {}) => ({
  v: PAYLOAD_VERSION,
  puzzle: context?.puzzle ?? null,
  target: context?.target ?? null,
  userAddress: context?.userAddress ?? null,
  pubkeyHex: context?.pubkeyHex ?? null,
  ts: context?.ts ?? null,
  tier1: tier1 ?? { attempted: false },
  note: tier1?.ok
    ? `Rebar Shield submission SUCCEEDED (txid ${tier1.txid}). This copy is a backup; act only if it fails to confirm.`
    : `Rebar Shield submission did NOT confirm sent${tier1?.error ? ` (${tier1.error})` : ""}. Submit one of the variants privately: Shield RPC, Slipstream (standard variant), or Braiins.`,
  variants: {
    shield: shield
      ? { txid: shield.txid, hex: shield.hex, feeAddress: shield.shieldAddress, feeSats: shield.shieldFee }
      : null,
    standard: standard
      ? { txid: standard.txid, hex: standard.hex, feeSats: standard.fee }
      : null,
  },
});

// Resolve the recipient hex pubkey from CLAIM_NPUB (or an override, for tests).
// The override skips the nip19 decode but NOT the module load: giftWrapClaim already
// awaited it for generateSecretKey and nip59 before calling this.
const claimPubkeyHex = async (override) => {
  if (override) return override;
  if (!CLAIM_NPUB) throw new Error("CLAIM_NPUB is not configured");
  const { nip19 } = await loadNostrTools();
  const d = nip19.decode(CLAIM_NPUB);
  if (d.type !== "npub") throw new Error(`CLAIM_NPUB is not an npub (got ${d.type})`);
  return d.data;
};

// NIP-44 encrypt + NIP-59 gift-wrap the payload to the claim key, signed by a
// fresh throwaway key (the user has no persistent Nostr identity, and we want
// none). Resolves to the signed kind-1059 gift-wrap event. `recipientHex` overrides
// CLAIM_NPUB for testing only.
//
// Outer wire event sent to relays:
//   {
//     "id": "<event id>",
//     "pubkey": "<ephemeral sender pubkey>",
//     "created_at": 1724430000,
//     "kind": 1059,
//     "tags": [["p", "<recipient hex pubkey>"]],
//     "content": "<NIP-44 encrypted rumor JSON>",
//     "sig": "<event signature>"
//   }
//
// Inner rumor before wrapping:
//   {
//     "kind": 14,
//     "created_at": 1724430000,
//     "tags": [["p", "<recipient hex pubkey>"]],
//     "content": "<JSON string from buildClaimPayload()>"
//   }
//
// ASYNC because it loads nostr-tools on demand (see the top of this file), so it can
// now fail on a network problem rather than only on bad input. Callers must treat
// that as a reportable status, not a fatal error: this is the developer's backup
// copy, and the finder holds the key and the signed hex either way. See the guard in
// claim-orchestrator.js.
export const giftWrapClaim = async (payload, { recipientHex, createdAt } = {}) => {
  const { generateSecretKey, nip59 } = await loadNostrTools();
  const recipient = await claimPubkeyHex(recipientHex);
  const senderSK = generateSecretKey();                 // ephemeral, discarded
  const rumor = {
    kind: 14,
    created_at: createdAt ?? Math.floor(Date.now() / 1000),
    tags: [["p", recipient]],
    content: JSON.stringify(payload),
  };
  return nip59.wrapEvent(rumor, senderSK, recipient);
};

// Publish a signed event to one relay over a raw wss:// WebSocket. Resolves
// true on OK-accepted, false on OK-rejected; rejects on timeout / ws error.
// Raw WS (not SimplePool) keeps this dependency-light and works in the browser.
const publishToRelay = (url, event, timeoutMs = 8000) =>
  new Promise((resolve, reject) => {
    let done = false;
    let ws;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      try { ws && ws.close(); } catch {}
      fn(arg);
    };
    try { ws = new WebSocket(url); }
    catch (e) { return reject(new Error(`relay ${url}: ${e.message}`)); }
    const timer = setTimeout(() => finish(reject, new Error(`relay ${url}: timeout`)), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify(["EVENT", event]));
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg[0] === "OK" && msg[1] === event.id) {
        clearTimeout(timer);
        finish(resolve, msg[2] === true);
      }
    };
    ws.onerror = () => { clearTimeout(timer); finish(reject, new Error(`relay ${url}: ws error`)); };
  });

// Publish the gift wrap to all configured relays. Never throws: returns a
// summary so the caller can decide to queue (offline) or fall back to the
// manual path. Resolves after every relay settles.
export const publishClaim = async (wrap, relays = CLAIM_RELAYS) => {
  const settled = await Promise.allSettled(relays.map((r) => publishToRelay(r, wrap)));
  const perRelay = relays.map((url, i) => {
    const r = settled[i];
    return {
      url,
      ok: r.status === "fulfilled" && r.value === true,
      error: r.status === "rejected" ? r.reason.message
           : (r.status === "fulfilled" && r.value === false ? "rejected by relay" : null),
    };
  });
  return { anyAccepted: perRelay.some((r) => r.ok), perRelay, eventId: wrap.id };
};

// Full Tier-2: assemble -> gift-wrap -> publish. Caller decides whether to queue
// on total failure (offline) or surface the manual fallback.
export const relayClaim = async ({ shield, standard, tier1, context, relays } = {}) => {
  const payload = buildClaimPayload({ shield, standard, tier1, context });
  const wrap = await giftWrapClaim(payload, { createdAt: context?.ts });
  const pub = await publishClaim(wrap, relays);
  return { ...pub, payload };
};
