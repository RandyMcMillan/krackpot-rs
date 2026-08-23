// Tier 1b of the private claim submission: MARA Slipstream.
//
// Slipstream routes a transaction straight to MARA's own pool without it entering
// the public mempool, so like Rebar Shield it does not expose the claim to
// front-running. Probed 2026-08-04: the API needs NO account and NO client ID
// (`client_code` exists but only buys a reduced fee-rate threshold), and it is
// CORS-open and origin-reflecting, so this runs from the browser with no backend.
// See docs/claim-privacy.md, "MARA Slipstream direct".
//
// Sent in PARALLEL with the Shield submission, not as a fallback. The two get
// DIFFERENT variants and those variants conflict (same inputs), which is fine and
// intended: at most one can confirm, both pay the finder the same 6 BTC, and two
// independent pools beat one. The 2026-07-27 dry run is why: Shield accepted a
// transaction and then never mined it for 64 blocks.
//
// Slipstream gets the STANDARD variant. It enforces a real on-chain fee rate (the
// floor is DYNAMIC: observed at 2 sat/vB and then 3 within the same day, so read it
// from /api/system rather than assuming) and the Shield variant deliberately
// carries a zero on-chain fee, paying via a dedicated output instead, so the
// Shield variant would fail a fee-rate check here.

import { SLIPSTREAM_SUBMIT_URL, SLIPSTREAM_TEST_URL, SLIPSTREAM_SYSTEM_URL } from "./config.js";

// Every call is time-bounded. Without this a blackholed endpoint stalls the whole
// claim: the orchestrator awaits both pools together, so one hung socket means the
// hit banner (which carries the key and the signed hex) never paints at all.
// Confirmed by simulation before this was added. 20 s is generous for a
// once-in-the-universe event and still bounded.
const TIMEOUT_MS = 20000;

// Shared POST helper. Slipstream returns JSON on both success and error.
const postJSON = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new Error(`Slipstream ${url}: non-JSON response (HTTP ${res.status})`);
  }
  return { res, payload };
};

// Pull an error message out of whatever shape the API returns. Beta API, so do not
// assume one field: check the documented ones, then fall back to the raw body.
// Remote-controlled text, so it is CAPPED. It reaches the hit banner and the
// developer's Nostr payload, and an unbounded string from a hostile or merely
// broken endpoint has no business in either.
const CAP = 200;
const errorText = (payload, status) => {
  const m = payload && (payload.error || payload.message || payload.detail || payload.reason);
  if (typeof m === "string" && m) return m.slice(0, CAP);
  if (m && typeof m === "object") return JSON.stringify(m).slice(0, CAP);
  return `HTTP ${status}`;
};

const TXID_RE = /^[0-9a-f]{64}$/i;

// Pull the txid out of a success response. The 2026-08-08 dry run showed the API
// does NOT use any of the field names the spec suggests: a real accepted
// submission came back as
//   {"status":"success","message":"<txid>"}
// so `message` carries the txid, not prose. Checking only txid/tx_id/id made a
// genuinely accepted transaction read as a failure: the claim got reported as
// Shield-only and the manual fallback advice was wrong.
//
// Note the asymmetry with the phantom-SUCCESS bug noted below, which is the more
// dangerous of the two. A phantom success can lose the prize, because you believe
// the transaction went out and never act on it. A phantom failure cannot: you act
// redundantly on a claim that is already in, and the 2026-08-08 dry run showed
// Slipstream answers a duplicate submission idempotently with the same txid. So
// this was a reporting defect, not a threat to the claim itself.
//
// So do not trust field names on this beta API. Take the first value among the
// plausible carriers that actually looks like a txid. `message` is deliberately
// included even though errorText() also reads it — the two never collide, because
// this runs only on res.ok and only accepts 64 hex chars.
const extractTxid = (payload) => {
  if (!payload) return null;
  for (const v of [payload.txid, payload.tx_id, payload.id, payload.message, payload.result]) {
    if (typeof v === "string" && TXID_RE.test(v)) return v;
  }
  return null;
};

// POST /api/transactions. Body needs only { tx_hex }. Returns { txid } on success.
// Throws on a rejection or transport failure so the caller can carry on to the
// other tiers. Unlike Shield's RPC this DOES check res.ok: a beta endpoint behind
// Cloudflare can return a non-2xx JSON error body, and treating that as success is
// exactly the bug that made the Shield path report a phantom submission.
export const submitToSlipstream = async (rawHex) => {
  const { res, payload } = await postJSON(SLIPSTREAM_SUBMIT_URL, { tx_hex: rawHex });
  if (!res.ok) throw new Error(`Slipstream submit: ${errorText(payload, res.status)}`);
  const txid = extractTxid(payload);
  if (!txid) {
    throw new Error(`Slipstream submit: accepted but returned no usable txid (${JSON.stringify(payload).slice(0, 160)})`);
  }
  return { txid };
};

// POST /api/mempool/tests. Consensus + policy check WITHOUT submitting.
//
// IMPORTANT, probed 2026-08-04: this endpoint REQUIRES an Authorization header
// ("Missing or invalid Authorization header") even though the OpenAPI document
// declares no securitySchemes at all. So the spec under-declares auth, and "no
// account needed" applies to /api/transactions only. Keeping this here because it
// costs nothing and becomes useful if an unauthenticated path ever appears.
//
// Returns { accepted, detail } and NEVER throws. `accepted` is deliberately
// three-valued: true/false only for a real policy verdict, and null for "could not
// tell", which is what an auth failure or a transport error gives. Conflating
// "auth required" with "transaction rejected" would be the same class of bug as
// Shield reporting a phantom success.
export const testSlipstreamAccept = async (rawHex) => {
  try {
    const { res, payload } = await postJSON(SLIPSTREAM_TEST_URL, { tx_hex: rawHex });
    if (!res.ok) return { accepted: null, detail: errorText(payload, res.status) };
    const allowed = payload && (payload.allowed ?? payload.accepted ?? payload.valid);
    return { accepted: allowed === undefined ? null : allowed !== false, detail: payload };
  } catch (e) {
    return { accepted: null, detail: e.message };
  }
};

// GET /api/system. Reports chain, block height and `slipstream_fee_rate_floor`, so
// the app can check the standard variant's hardcoded rate still clears the floor
// instead of assuming the 2 sat/vB seen at probe time holds forever.
export const fetchSlipstreamSystem = async () => {
  const res = await fetch(SLIPSTREAM_SYSTEM_URL, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Slipstream /system: HTTP ${res.status}`);
  return res.json();
};
