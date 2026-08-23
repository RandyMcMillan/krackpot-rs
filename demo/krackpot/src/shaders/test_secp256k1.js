// Test entrypoints for secp256k1.
// Input: a U256 scalar.
// Output: 16 LE u32 limbs = (X affine, Y affine), then a u32 is_infinity flag.

import { secp256k1WGSL } from "./secp256k1.js";

export const testSecp256k1WGSL = secp256k1WGSL + /* wgsl */ `

struct SecOut {
  x: U256,
  y: U256,
  is_inf: u32,
};

@group(0) @binding(0) var<storage, read>       sec_in:  U256;
@group(0) @binding(1) var<storage, read_write> sec_out: SecOut;

@compute @workgroup_size(1) fn test_scalar_mul_g() {
  let R = scalar_mul_g(sec_in);
  let aff = jacobian_to_affine(R);
  sec_out.x = aff.x;
  sec_out.y = aff.y;
  sec_out.is_inf = aff.is_inf;
}

// Test the mixed-add hot path independently: compute scalar_mul_g(k), then add G,
// and return the affine result. Should equal scalar_mul_g(k+1).
@compute @workgroup_size(1) fn test_kG_plus_G() {
  let R0 = scalar_mul_g(sec_in);
  let R1 = point_add_mixed(R0, U256(GX_LIMBS), U256(GY_LIMBS));
  let aff = jacobian_to_affine(R1);
  sec_out.x = aff.x;
  sec_out.y = aff.y;
  sec_out.is_inf = aff.is_inf;
}

// Test point doubling independently.
@compute @workgroup_size(1) fn test_double_kG() {
  let R0 = scalar_mul_g(sec_in);
  let R1 = point_double(R0);
  let aff = jacobian_to_affine(R1);
  sec_out.x = aff.x;
  sec_out.y = aff.y;
  sec_out.is_inf = aff.is_inf;
}
`;
