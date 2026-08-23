// CPU end-to-end: privkey -> compressed P2PKH address.

import { scalarMul, compressPubkey } from "./secp.js";
import { ripemd160 } from "./ripemd160.js";
import { encodeP2PKH } from "./base58.js";

const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

export const privToPkh = async (privBigInt) => {
  const pub = scalarMul(privBigInt);
  const compressed = compressPubkey(pub);
  const sha = await sha256(compressed);
  const pkh = ripemd160(sha);
  return pkh;
};

export const privToAddress = async (privBigInt) => {
  const pkh = await privToPkh(privBigInt);
  return encodeP2PKH(pkh);
};
