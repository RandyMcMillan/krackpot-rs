// Static target + range for the search. Hardcoded here (not surfaced via URL
// params or editable fields) so that every shared/installed instance of the
// tool searches the same Bitcoin Puzzle, and so the share URL surface area
// is limited to payout address + autostart flag.
//
// To re-aim the tool at a different puzzle, edit this file and re-run the
// UTXO capture for the new target address.

// Bitcoin Puzzle #71: scalar range 2^70 .. 2^71 - 1.
export const TARGET_ADDRESS = "1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU";
export const RANGE_START = 0x400000000000000000n;
export const RANGE_END   = 0x7fffffffffffffffffn;
export const DEFAULT_PAYOUT_ADDRESS = "bc1qq5y98nxyscu6x74z30ym44wwyz4usu95ryende";

// Sanity check (cheap, helps catch typos at module load instead of at hit time).
if (RANGE_END <= RANGE_START) {
  throw new Error("config.js: RANGE_END must be > RANGE_START");
}

// ---------------------------------------------------------------------------
// Prize-claim submission (see docs/claim-privacy.md).
//
// The tool NEVER broadcasts to the public mempool: a public spend reveals the
// pubkey and, because the key sits in a narrow range, a bot recovers it with
// Pollard's kangaroo and front-runs the claim. Submission is private, in tiers:
//   Tier 1  browser POSTs the signed tx to Rebar Shield's private-mempool RPC
//   Tier 2  browser relays the encrypted signed tx to the developer over Nostr
//   Tier 3  UI shows manual MARA Slipstream instructions if Tier 1 errors
// ---------------------------------------------------------------------------

// Tier 1 — Rebar Shield. Out-of-band, CORS-open, account-free (verified
// 2026-07-24). The Shield fee is paid as a dedicated tx output to the address
// from /info; the on-chain miner fee is 0. See src/shield.js.
export const SHIELD_INFO_URL = "https://shield.rebarlabs.io/v1/info";
export const SHIELD_RPC_URL  = "https://shield.rebarlabs.io/v1/rpc";

// Tier 1b — MARA Slipstream, submitted in PARALLEL with Shield, not as a fallback.
// No account and no client ID needed, and CORS-open + origin-reflecting (probed
// 2026-08-04), so the browser can post directly. It gets the STANDARD variant
// because it enforces a real on-chain fee rate (floor 2 sat/vB) and the Shield
// variant carries a deliberate zero on-chain fee. The two variants conflict by
// design: at most one confirms, both pay the finder the same 6 BTC. Beta API at
// 0.1.0-beta, so treat every call as best-effort. See src/slipstream.js.
export const SLIPSTREAM_SUBMIT_URL = "https://slipstream.mara.com/api/transactions";
export const SLIPSTREAM_TEST_URL   = "https://slipstream.mara.com/api/mempool/tests";
export const SLIPSTREAM_SYSTEM_URL = "https://slipstream.mara.com/api/system";

// Tier 2 — Nostr relay of the encrypted signed tx to the developer.
// This is the DEDICATED claim-only key (generated offline 2026-07-29, decoupled
// from Simon's social/launch identity), per docs/claim-privacy.md. Only the npub
// lives here; the matching nsec never appears in the app and is kept offline.
// Rotating it is a config edit plus an sw.js VERSION bump — note that stale
// installs keep encrypting to the old key until they pick up the new worker.
// Verify a candidate key before shipping it: scripts/verify-claim-key.mjs.
export const CLAIM_NPUB = "npub1xgesh2v9m6jjxxz4s7nc3qtjqcs7mtg6ydueujfqt0vw05w0e79sh2n30c";
export const CLAIM_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
  "wss://relay.snort.social",
];
