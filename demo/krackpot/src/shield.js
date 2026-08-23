// Tier 1 of the private claim submission: Rebar Shield.
//
// Rebar Shield is a Bitcoin-Core-compatible JSON-RPC endpoint that routes a
// transaction to partner mining pools' PRIVATE mempools, so the public key is
// only revealed once the tx is already confirmed in a block. This is NOT the
// public mempool, so it does not expose the claim to front-running. Verified
// 2026-07-24: the endpoint is CORS-open (reflects an arbitrary Origin) and
// accepts unauthenticated calls, so this runs straight from the browser with
// no account. See docs/claim-privacy.md for the threat model and the analysis.
//
// Fee model (verified against a live Shield tx): the Shield fee is paid as a
// dedicated tx OUTPUT to the address returned by /info, and the on-chain miner
// fee is 0 (inputs = outputs). This module only talks to Shield; wiring the fee
// output and the 0-fee split into the transaction lives in prize-claim.js,
// which will call pickShieldTier() + computeShieldFeeSats(vsize) at build time.

import { SHIELD_INFO_URL, SHIELD_RPC_URL } from "./config.js";

// GET /v1/info. Shape:
//   { height, payment: { p2wpkh }, fees: [{ estimated_hashrate, feerate }, ...] }
// The payment address and fee tiers are DYNAMIC, so this must be fetched at
// claim time, never hardcoded. A simple cross-origin GET (no preflight).
// Time-bounded for the same reason as src/slipstream.js: the orchestrator awaits
// both pools together, so one hung socket would stop the hit banner ever painting.
const TIMEOUT_MS = 20000;

export const fetchShieldInfo = async () => {
  const res = await fetch(SHIELD_INFO_URL, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Shield /info: HTTP ${res.status}`);
  const info = await res.json();
  if (!info || !info.payment || !info.payment.p2wpkh
      || !Array.isArray(info.fees) || info.fees.length === 0) {
    throw new Error("Shield /info: unexpected shape (no payment address or fee tiers)");
  }
  return info;
};

// Choose the top hashrate-coverage tier (highest feerate offered). Losing a
// once-in-the-universe prize dwarfs the fee (a few thousand sats on ~7.1 BTC),
// so we always buy the most inclusion probability available.
// Returns { feerateSatPerVb: BigInt, address: string, estimatedHashrate: number }.
export const pickShieldTier = (info) => {
  const top = info.fees.reduce((best, f) => (f.feerate > best.feerate ? f : best));
  return {
    feerateSatPerVb: BigInt(Math.ceil(top.feerate)),
    address: info.payment.p2wpkh,
    estimatedHashrate: top.estimated_hashrate,
  };
};

// Shield fee in sats for a given tx virtual size: fee = feerate * vsize. The
// output type is fixed, so vsize is deterministic once inputs + output count are
// known (compute it WITH the fee output present); no iteration needed.
export const computeShieldFeeSats = (feerateSatPerVb, vbytes) =>
  BigInt(feerateSatPerVb) * BigInt(vbytes);

// POST sendrawtransaction to the Shield RPC. Returns { txid } on success.
// Throws on a JSON-RPC error (e.g. rejected tx) or a transport failure, so the
// caller can fall through to Tier 3 (manual Slipstream instructions).
export const submitToShield = async (rawHex) => {
  const res = await fetch(SHIELD_RPC_URL, {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "krackpot-claim",
      method: "sendrawtransaction",
      params: [rawHex],
    }),
  });

  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new Error(`Shield RPC: non-JSON response (HTTP ${res.status})`);
  }
  if (payload && payload.error) {
    const { code, message } = payload.error;
    // Capped: remote text that reaches the hit banner and the Nostr payload.
    throw new Error(`Shield RPC error ${code}: ${String(message ?? "").slice(0, 200)}`);
  }
  // Bitcoin's sendrawtransaction returns the txid string in `result`.
  return { txid: payload && payload.result };
};
