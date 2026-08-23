// End-to-end test pipeline: pkkey -> compressed pubkey -> SHA-256 -> RIPEMD-160 -> PKH.
// This is the hard gate from CLAUDE.md — only when these tests pass against the
// Puzzle #1/#2/#3 reference addresses can the search loop run.

import { secp256k1WGSL } from "./secp256k1.js";   // includes bigintWGSL
import { sha256WGSL } from "./sha256.js";
import { ripemd160WGSL } from "./ripemd160.js";

export const testPipelineWGSL = secp256k1WGSL + sha256WGSL + ripemd160WGSL + /* wgsl */ `

@group(0) @binding(0) var<storage, read>       pk_in: U256;
@group(0) @binding(1) var<storage, read_write> pkh_out: array<u32, 5>;

// Pack a compressed pubkey (1 prefix byte + 32 BE bytes of X) into 14 BE u32 words
// suitable for sha256_short with byte_len = 33.
//
// The 33 bytes are laid out as words[0..8].high:
//   word[0] = (prefix << 24) | (X_BE[0..2] in low 24 bits)
//   word[i] for 1..7: (X_BE[4i-1] in high byte) | (X_BE[4i..4i+2] in low 24)
//   word[8] = (X_BE[31] in high byte)
fn pubkey_to_sha_input(x: U256, prefix: u32) -> array<u32, 14> {
  var w: array<u32, 14>;
  w[0] = (prefix << 24u) | ((x.limbs[7] >> 8u) & 0x00FFFFFFu);
  for (var i: u32 = 1u; i < 8u; i = i + 1u) {
    let hi   = (x.limbs[8u - i] & 0xFFu) << 24u;
    let lo24 = (x.limbs[7u - i] >> 8u) & 0x00FFFFFFu;
    w[i] = hi | lo24;
  }
  w[8] = (x.limbs[0] & 0xFFu) << 24u;
  for (var i: u32 = 9u; i < 14u; i = i + 1u) { w[i] = 0u; }
  return w;
}

// Byte-swap a u32 (BE <-> LE 4-byte word).
fn bswap32(x: u32) -> u32 {
  let a = (x >> 24u) & 0x000000FFu;
  let b = (x >> 8u)  & 0x0000FF00u;
  let c = (x << 8u)  & 0x00FF0000u;
  let d = (x << 24u) & 0xFF000000u;
  return a | b | c | d;
}

fn pk_to_pkh(pk: U256, add_g: bool) -> array<u32, 5> {
  var R = scalar_mul_g(pk);
  if (add_g) {
    R = point_add_mixed(R, U256(GX_LIMBS), U256(GY_LIMBS));
  }
  let aff = jacobian_to_affine(R);
  let prefix = select(0x02u, 0x03u, (aff.y.limbs[0] & 1u) == 1u);
  let sha_words = pubkey_to_sha_input(aff.x, prefix);
  let sha = sha256_short(sha_words, 33u);

  var rm_in: array<u32, 14>;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) { rm_in[i] = bswap32(sha[i]); }
  for (var i: u32 = 8u; i < 14u; i = i + 1u) { rm_in[i] = 0u; }
  return ripemd160_short(rm_in, 32u);
}

@compute @workgroup_size(1) fn test_pk_to_pkh() {
  let pkh = pk_to_pkh(pk_in, false);
  for (var i: u32 = 0u; i < 5u; i = i + 1u) { pkh_out[i] = pkh[i]; }
}

@compute @workgroup_size(1) fn test_pk_plus_g_to_pkh() {
  let pkh = pk_to_pkh(pk_in, true);
  for (var i: u32 = 0u; i < 5u; i = i + 1u) { pkh_out[i] = pkh[i]; }
}
`;
