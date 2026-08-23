// Test entrypoint for RIPEMD-160. Layout mirrors test_sha256 but words are LE-packed.

import { ripemd160WGSL } from "./ripemd160.js";

export const testRipemd160WGSL = ripemd160WGSL + /* wgsl */ `

struct RmIn {
  byte_len: u32,
  words: array<u32, 14>,
};

@group(0) @binding(0) var<storage, read>       rm_in:  RmIn;
@group(0) @binding(1) var<storage, read_write> rm_out: array<u32, 5>;

@compute @workgroup_size(1) fn test_ripemd160() {
  var bytes: array<u32, 14>;
  for (var i: u32 = 0u; i < 14u; i = i + 1u) { bytes[i] = rm_in.words[i]; }
  let h = ripemd160_short(bytes, rm_in.byte_len);
  for (var i: u32 = 0u; i < 5u; i = i + 1u) { rm_out[i] = h[i]; }
}
`;
