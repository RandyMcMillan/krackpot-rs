// secp256k1 elliptic curve in WGSL.
// Jacobian coordinates (X, Y, Z) representing affine (X/Z², Y/Z³).
// Point at infinity is represented by Z = 0.
// Scalar multiplication by G uses mixed Jacobian-affine addition (the hot path
// for the search loop, where G is a known affine constant).

import { bigintWGSL } from "./bigint.js";

export const secp256k1WGSL = bigintWGSL + /* wgsl */ `

// Generator G in affine form. LE limbs.
// Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
// Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
const GX_LIMBS: array<u32, 8> = array<u32, 8>(
  0x16F81798u, 0x59F2815Bu, 0x2DCE28D9u, 0x029BFCDBu,
  0xCE870B07u, 0x55A06295u, 0xF9DCBBACu, 0x79BE667Eu
);
const GY_LIMBS: array<u32, 8> = array<u32, 8>(
  0xFB10D4B8u, 0x9C47D08Fu, 0xA6855419u, 0xFD17B448u,
  0x0E1108A8u, 0x5DA4FBFCu, 0x26A3C465u, 0x483ADA77u
);

struct Point  { x: U256, y: U256, z: U256 };
struct Affine { x: U256, y: U256, is_inf: u32 };

fn point_infinity() -> Point {
  return Point(u256_zero(), u256_zero(), u256_zero());
}

fn is_infinity(p: Point) -> bool {
  return u256_is_zero(p.z);
}

fn fp_dbl(a: U256) -> U256 { return fp_add(a, a); }
fn fp_tri(a: U256) -> U256 { return fp_add(fp_dbl(a), a); }

// Doubling on y² = x³ + 7 (a = 0). Standard formulas:
//   S = 4 * X * Y²
//   M = 3 * X²
//   X' = M² - 2S
//   Y' = M(S - X') - 8 * Y⁴
//   Z' = 2 * Y * Z
fn point_double(p: Point) -> Point {
  if (is_infinity(p)) { return p; }
  let y2 = fp_sqr(p.y);
  let xy2 = fp_mul(p.x, y2);
  let s = fp_dbl(fp_dbl(xy2));            // 4XY²
  let m = fp_tri(fp_sqr(p.x));            // 3X²
  let x3 = fp_sub(fp_sqr(m), fp_dbl(s));
  let y4 = fp_sqr(y2);
  let y8 = fp_dbl(fp_dbl(fp_dbl(y4)));    // 8Y⁴
  let y3 = fp_sub(fp_mul(m, fp_sub(s, x3)), y8);
  let z3 = fp_dbl(fp_mul(p.y, p.z));
  return Point(x3, y3, z3);
}

// Mixed addition: p1 in Jacobian, q in affine (so Z_q = 1 implicitly).
// U1 = X1, U2 = qx * Z1²
// S1 = Y1, S2 = qy * Z1³
// H = U2 - U1; R = S2 - S1
// X3 = R² - H³ - 2 U1 H²
// Y3 = R(U1 H² - X3) - S1 H³
// Z3 = H * Z1
fn point_add_mixed(p1: Point, qx: U256, qy: U256) -> Point {
  if (is_infinity(p1)) {
    return Point(qx, qy, u256_one());
  }

  let z1_sq = fp_sqr(p1.z);
  let z1_cu = fp_mul(z1_sq, p1.z);

  let u1 = p1.x;
  let u2 = fp_mul(qx, z1_sq);
  let s1 = p1.y;
  let s2 = fp_mul(qy, z1_cu);

  if (u256_eq(u1, u2)) {
    if (u256_eq(s1, s2)) {
      return point_double(p1);
    }
    return point_infinity();  // P + (-P) = O
  }

  let h = fp_sub(u2, u1);
  let r = fp_sub(s2, s1);
  let h_sq = fp_sqr(h);
  let h_cu = fp_mul(h_sq, h);
  let u1_h_sq = fp_mul(u1, h_sq);

  let x3 = fp_sub(fp_sub(fp_sqr(r), h_cu), fp_dbl(u1_h_sq));
  let y3 = fp_sub(fp_mul(r, fp_sub(u1_h_sq, x3)), fp_mul(s1, h_cu));
  let z3 = fp_mul(h, p1.z);
  return Point(x3, y3, z3);
}

// Scalar multiplication k * G via double-and-add, MSB first.
fn scalar_mul_g(k: U256) -> Point {
  let gx = U256(GX_LIMBS);
  let gy = U256(GY_LIMBS);
  var R = point_infinity();
  // Walk limbs MSB→LSB; within each limb, bit 31 down to bit 0.
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let limb = k.limbs[7u - i];
    for (var b: u32 = 0u; b < 32u; b = b + 1u) {
      R = point_double(R);
      let bit_val = (limb >> (31u - b)) & 1u;
      if (bit_val == 1u) {
        R = point_add_mixed(R, gx, gy);
      }
    }
  }
  return R;
}

// Same but for a 32-bit scalar — skips 224 useless doublings of infinity.
// Used per-thread in the search shader to compute small offsets cheaply.
fn scalar_mul_g_u32(k: u32) -> Point {
  let gx = U256(GX_LIMBS);
  let gy = U256(GY_LIMBS);
  var R = point_infinity();
  for (var b: u32 = 0u; b < 32u; b = b + 1u) {
    R = point_double(R);
    if (((k >> (31u - b)) & 1u) == 1u) {
      R = point_add_mixed(R, gx, gy);
    }
  }
  return R;
}

// Convert Jacobian to affine. Caller must ensure p is not the point at infinity
// (callers can check is_infinity beforehand).
fn jacobian_to_affine(p: Point) -> Affine {
  if (is_infinity(p)) {
    return Affine(u256_zero(), u256_zero(), 1u);
  }
  let z_inv = fp_inv(p.z);
  let z_inv_sq = fp_sqr(z_inv);
  let z_inv_cu = fp_mul(z_inv_sq, z_inv);
  let x = fp_mul(p.x, z_inv_sq);
  let y = fp_mul(p.y, z_inv_cu);
  return Affine(x, y, 0u);
}
`;
