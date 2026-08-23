// Share-link parsing and generation.
//
// URL params recognised:
//   pay        : the Bitcoin address that receives the 6 BTC user payout.
//   autostart  : "1" to auto-click Start after preflight passes.
//
// Target address and range are NOT URL-shareable — they live in src/config.js.
// This limits the share surface to "who gets paid" + "should it run on load",
// which is everything a share-recipient cares about.
//
// All param values are STRICTLY validated character-set + length before being
// applied to the DOM. This is the XSS firewall — `<script>`, `javascript:`,
// or any other markup-like content is rejected at parse time, never reaches
// any element. We additionally only ever assign to `.value` or `.textContent`,
// never `.innerHTML`.

// Bitcoin mainnet address shapes:
//   Legacy P2PKH/P2SH  : starts with 1 or 3, base58 alphabet (no 0OIl),
//                         total length 26-35 chars.
//   Native SegWit/Taproot: starts with bc1, bech32 alphabet (lowercase only,
//                         no b, i, o, 1), total length 14-90 chars.
const BTC_ADDR_RE = /^(?:[13][1-9A-HJ-NP-Za-km-z]{25,34}|bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,87})$/;

export const isLikelyBitcoinAddress = (s) =>
  typeof s === "string" && s.length <= 90 && BTC_ADDR_RE.test(s);

const FLAG_TRUE = new Set(["1", "true", "yes", "on"]);

export const parseShareParams = (url = window.location.href) => {
  let q;
  try { q = new URL(url).searchParams; }
  catch { return {}; }

  const out = {};
  const pay = q.get("pay");
  if (pay && isLikelyBitcoinAddress(pay)) out.pay = pay;

  const auto = q.get("autostart");
  if (auto && FLAG_TRUE.has(auto.toLowerCase())) out.autostart = true;

  return out;
};

// Build a sharable URL from the current form state.
export const buildShareURL = ({ pay, autostart }) => {
  const u = new URL(window.location.href);
  u.search = "";
  if (pay && isLikelyBitcoinAddress(pay)) u.searchParams.set("pay", pay);
  if (autostart) u.searchParams.set("autostart", "1");
  return u.toString();
};

// Share or copy. Returns { method: "share" | "clipboard" | "manual", text: <fallback> }.
export const shareOrCopy = async (url, title = "WebGPU Bitcoin Puzzle Solver") => {
  if (typeof navigator !== "undefined" && navigator.share) {
    try {
      await navigator.share({ url, title });
      return { method: "share" };
    } catch (e) {
      // User cancelled or share refused — fall through to clipboard.
      if (e?.name === "AbortError") return { method: "share", cancelled: true };
    }
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(url);
      return { method: "clipboard" };
    } catch { /* fall through */ }
  }
  return { method: "manual", text: url };
};
