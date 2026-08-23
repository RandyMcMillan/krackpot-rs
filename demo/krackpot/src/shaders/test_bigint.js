// WGSL test entry points for the BigInt module.
// Layout: input buffer carries operands (laid out as 8 u32 LE limbs each), output buffer
// receives results (also LE limbs). Each test has its own @compute entrypoint.

import { bigintWGSL } from "./bigint.js";

export const testBigintWGSL = bigintWGSL + /* wgsl */ `

struct InTwo  { a: U256, b: U256 };
struct InOne  { a: U256 };
struct Out256 { r: U256 };
struct Out512 { r: U512 };

@group(0) @binding(0) var<storage, read>       in_two:  InTwo;
@group(0) @binding(1) var<storage, read_write> out_256: Out256;

@compute @workgroup_size(1) fn test_u256_add() {
  let s = u256_add_raw(in_two.a, in_two.b);
  out_256.r = s.sum;
}

@compute @workgroup_size(1) fn test_u256_sub() {
  let d = u256_sub_raw(in_two.a, in_two.b);
  out_256.r = d.diff;
}

@compute @workgroup_size(1) fn test_fp_add() {
  out_256.r = fp_add(in_two.a, in_two.b);
}

@compute @workgroup_size(1) fn test_fp_sub() {
  out_256.r = fp_sub(in_two.a, in_two.b);
}

@compute @workgroup_size(1) fn test_fp_mul() {
  out_256.r = fp_mul(in_two.a, in_two.b);
}

@compute @workgroup_size(1) fn test_fp_sqr() {
  out_256.r = fp_sqr(in_two.a);
}

@compute @workgroup_size(1) fn test_fp_inv() {
  out_256.r = fp_inv(in_two.a);
}
`;
