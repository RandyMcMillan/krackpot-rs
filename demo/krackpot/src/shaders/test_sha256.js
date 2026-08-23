// Test entrypoint for SHA-256. Input layout:
//   byte_len: u32 (offset 0)
//   _pad:     u32 x 3 (offset 4..16)
//   words:    u32 x 14 (BE-packed bytes; offset 16..72)
// Output: 8 u32 of state in BE byte order — i.e., state[0]'s bytes are out[0..3].

import { sha256WGSL } from "./sha256.js";

export const testSha256WGSL = sha256WGSL + /* wgsl */ `

struct ShaIn {
  byte_len: u32,
  words: array<u32, 14>,
};

@group(0) @binding(0) var<storage, read>       sha_in:  ShaIn;
@group(0) @binding(1) var<storage, read_write> sha_out: array<u32, 8>;

@compute @workgroup_size(1) fn test_sha256() {
  var bytes: array<u32, 14>;
  for (var i: u32 = 0u; i < 14u; i = i + 1u) { bytes[i] = sha_in.words[i]; }
  let h = sha256_short(bytes, sha_in.byte_len);
  for (var i: u32 = 0u; i < 8u; i = i + 1u) { sha_out[i] = h[i]; }
}
`;
