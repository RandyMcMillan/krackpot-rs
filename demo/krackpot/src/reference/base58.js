// Base58Check encode/decode for Bitcoin P2PKH addresses.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const sha256 = async (bytes) => {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(buf);
};

export const base58Encode = (bytes) => {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    const r = Number(n % 58n);
    n /= 58n;
    s = ALPHABET[r] + s;
  }
  for (const b of bytes) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s;
};

export const base58Decode = (str) => {
  let n = 0n;
  for (const ch of str) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error("invalid base58 char: " + ch);
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xFFn));
    n >>= 8n;
  }
  for (const ch of str) {
    if (ch === "1") bytes.unshift(0);
    else break;
  }
  return new Uint8Array(bytes);
};

export const base58CheckEncode = async (payload) => {
  const checksum = (await sha256(await sha256(payload))).slice(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload, 0);
  full.set(checksum, payload.length);
  return base58Encode(full);
};

export const base58CheckDecode = async (str) => {
  const full = base58Decode(str);
  if (full.length < 5) throw new Error("base58check too short");
  const payload = full.slice(0, full.length - 4);
  const givenSum = full.slice(full.length - 4);
  const want = (await sha256(await sha256(payload))).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (givenSum[i] !== want[i]) throw new Error("base58check checksum mismatch");
  }
  return payload;
};

// Decode a P2PKH mainnet address into its raw 20-byte PKH.
export const decodeP2PKH = async (address) => {
  const payload = await base58CheckDecode(address);
  if (payload.length !== 21) throw new Error("not a P2PKH payload");
  if (payload[0] !== 0x00) throw new Error("not a mainnet P2PKH (version != 0x00)");
  return payload.slice(1);
};

export const encodeP2PKH = async (pkh20) => {
  if (pkh20.length !== 20) throw new Error("pkh must be 20 bytes");
  const payload = new Uint8Array(21);
  payload[0] = 0x00;
  payload.set(pkh20, 1);
  return base58CheckEncode(payload);
};
