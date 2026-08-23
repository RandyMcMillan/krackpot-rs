// 256-bit (8 limb) and 512-bit (16 limb) unsigned integer math in WGSL.
// Limbs are little-endian: limb[0] is least significant 32 bits.
// All field operations are modulo p = 2^256 - 2^32 - 977 (secp256k1 prime).

export const bigintWGSL = /* wgsl */ `

struct U256 { limbs: array<u32, 8> };
struct U512 { limbs: array<u32, 16> };

// p = 2^256 - 0x1000003D1
// Little-endian limbs:
const P_LIMBS: array<u32, 8> = array<u32, 8>(
  0xFFFFFC2Fu, 0xFFFFFFFEu, 0xFFFFFFFFu, 0xFFFFFFFFu,
  0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu
);

fn u256_zero() -> U256 {
  return U256(array<u32, 8>(0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u));
}

fn u256_one() -> U256 {
  return U256(array<u32, 8>(1u, 0u, 0u, 0u, 0u, 0u, 0u, 0u));
}

fn u256_eq(a: U256, b: U256) -> bool {
  var diff: u32 = 0u;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    diff = diff | (a.limbs[i] ^ b.limbs[i]);
  }
  return diff == 0u;
}

fn u256_is_zero(a: U256) -> bool {
  var acc: u32 = 0u;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    acc = acc | a.limbs[i];
  }
  return acc == 0u;
}

// Returns 1u if a >= b, else 0u.
fn u256_geq(a: U256, b: U256) -> u32 {
  var borrow: u32 = 0u;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let ai = a.limbs[i];
    let bi = b.limbs[i];
    let s1 = ai - bi;
    let b1 = u32(ai < bi);
    let s2 = s1 - borrow;
    let b2 = u32(s1 < borrow);
    borrow = b1 + b2;
  }
  return 1u - borrow;
}

// (a + b) -> (sum, carry)
struct AddOut { sum: U256, carry: u32 };
fn u256_add_raw(a: U256, b: U256) -> AddOut {
  var r: U256;
  var carry: u32 = 0u;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let s = a.limbs[i] + b.limbs[i];
    let c1 = u32(s < a.limbs[i]);
    let s2 = s + carry;
    let c2 = u32(s2 < s);
    r.limbs[i] = s2;
    carry = c1 + c2;
  }
  return AddOut(r, carry);
}

// (a - b) -> (diff, borrow)
struct SubOut { diff: U256, borrow: u32 };
fn u256_sub_raw(a: U256, b: U256) -> SubOut {
  var r: U256;
  var borrow: u32 = 0u;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let s1 = a.limbs[i] - b.limbs[i];
    let b1 = u32(a.limbs[i] < b.limbs[i]);
    let s2 = s1 - borrow;
    let b2 = u32(s1 < borrow);
    r.limbs[i] = s2;
    borrow = b1 + b2;
  }
  return SubOut(r, borrow);
}

// 32 x 32 -> 64 multiplication, returned as vec2<u32>(lo, hi).
fn mul32(a: u32, b: u32) -> vec2<u32> {
  let ah: u32 = a >> 16u;
  let al: u32 = a & 0xFFFFu;
  let bh: u32 = b >> 16u;
  let bl: u32 = b & 0xFFFFu;
  let ll: u32 = al * bl;
  let lh: u32 = al * bh;
  let hl: u32 = ah * bl;
  let hh: u32 = ah * bh;
  let mid: u32 = (ll >> 16u) + (lh & 0xFFFFu) + (hl & 0xFFFFu);
  let lo: u32  = (ll & 0xFFFFu) | (mid << 16u);
  let hi: u32  = hh + (lh >> 16u) + (hl >> 16u) + (mid >> 16u);
  return vec2<u32>(lo, hi);
}

// 256 x 256 -> 512.
fn u256_mul(a: U256, b: U256) -> U512 {
  var r: U512;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) { r.limbs[i] = 0u; }
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    var carry: u32 = 0u;
    for (var j: u32 = 0u; j < 8u; j = j + 1u) {
      let prod: vec2<u32> = mul32(a.limbs[i], b.limbs[j]);
      // r[i+j] += prod.x + carry, then propagate prod.y + new carry into r[i+j+1]
      let cur: u32 = r.limbs[i + j];
      let s1: u32 = cur + prod.x;
      let c1: u32 = u32(s1 < cur);
      let s2: u32 = s1 + carry;
      let c2: u32 = u32(s2 < s1);
      r.limbs[i + j] = s2;
      carry = prod.y + c1 + c2;
    }
    r.limbs[i + 8u] = r.limbs[i + 8u] + carry;
  }
  return r;
}

// Reduce a 512-bit value mod p, where p = 2^256 - C and C = 0x1000003D1.
// Approach: a = lo + hi * 2^256  =>  a mod p = lo + hi * C (mod p).
// We use a 10-limb buffer so any spill past the low 256 bits is preserved
// rather than silently truncated (the bug that broke (p-1)*(p-1)).
// After folding the high 8 limbs once, residual overflow lives in r[8..9];
// iterate folding until it's zero, then conditional subtract p.
fn mod_p(a: U512) -> U256 {
  var r: array<u32, 10>;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) { r[i] = a.limbs[i]; }
  r[8] = 0u; r[9] = 0u;

  // First fold: r[0..7] += hi * (2^32 + 977).
  // Step A: r[0..8] += hi * 977.
  {
    var carry: u32 = 0u;
    for (var i: u32 = 0u; i < 8u; i = i + 1u) {
      let prod = mul32(a.limbs[i + 8u], 977u);
      let s1 = r[i] + prod.x;
      let c1 = u32(s1 < r[i]);
      let s2 = s1 + carry;
      let c2 = u32(s2 < s1);
      r[i] = s2;
      carry = prod.y + c1 + c2;
    }
    r[8] = carry;
  }
  // Step B: r[1..9] += hi (i.e., hi shifted up by 32 bits).
  {
    var carry: u32 = 0u;
    for (var i: u32 = 0u; i < 8u; i = i + 1u) {
      let dest = r[i + 1u];
      let s1 = dest + a.limbs[i + 8u];
      let c1 = u32(s1 < dest);
      let s2 = s1 + carry;
      let c2 = u32(s2 < s1);
      r[i + 1u] = s2;
      carry = c1 + c2;
    }
    r[9] = r[9] + carry;
  }

  // Iterate folding the 257..289-bit overflow in r[8..9] back into r[0..7].
  // In practice this converges in at most 2 passes; cap at 4 for safety.
  for (var iter: u32 = 0u; iter < 4u; iter = iter + 1u) {
    let extra_lo = r[8];
    let extra_hi = r[9];
    if ((extra_lo | extra_hi) == 0u) { break; }
    r[8] = 0u; r[9] = 0u;

    // r += extra_lo * 977 at limb 0.
    {
      let prod = mul32(extra_lo, 977u);
      var c: u32 = 0u;
      let sa = r[0] + prod.x;
      c = u32(sa < r[0]);
      r[0] = sa;
      let sb = r[1] + prod.y;
      let cb = u32(sb < r[1]);
      let sc = sb + c;
      let cc = u32(sc < sb);
      r[1] = sc;
      c = cb + cc;
      for (var i: u32 = 2u; i < 10u; i = i + 1u) {
        if (c == 0u) { break; }
        let s = r[i] + c;
        c = u32(s < r[i]);
        r[i] = s;
      }
    }
    // r += extra_lo at limb 1 (extra_lo * 2^32).
    {
      var c: u32 = 0u;
      let sa = r[1] + extra_lo;
      c = u32(sa < r[1]);
      r[1] = sa;
      for (var i: u32 = 2u; i < 10u; i = i + 1u) {
        if (c == 0u) { break; }
        let s = r[i] + c;
        c = u32(s < r[i]);
        r[i] = s;
      }
    }
    // extra_hi sits at limb-9 position (value * 2^288). Reduce: 2^288 = 2^32 * 2^256
    // ≡ 2^32 * (2^32 + 977) = 2^64 + 977 * 2^32 (mod p).
    // r += extra_hi * 977 at limb 1; r += extra_hi at limb 2.
    {
      let prod = mul32(extra_hi, 977u);
      var c: u32 = 0u;
      let sa = r[1] + prod.x;
      c = u32(sa < r[1]);
      r[1] = sa;
      let sb = r[2] + prod.y;
      let cb = u32(sb < r[2]);
      let sc = sb + c;
      let cc = u32(sc < sb);
      r[2] = sc;
      c = cb + cc;
      for (var i: u32 = 3u; i < 10u; i = i + 1u) {
        if (c == 0u) { break; }
        let s = r[i] + c;
        c = u32(s < r[i]);
        r[i] = s;
      }
    }
    {
      var c: u32 = 0u;
      let sa = r[2] + extra_hi;
      c = u32(sa < r[2]);
      r[2] = sa;
      for (var i: u32 = 3u; i < 10u; i = i + 1u) {
        if (c == 0u) { break; }
        let s = r[i] + c;
        c = u32(s < r[i]);
        r[i] = s;
      }
    }
  }

  var out: U256;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) { out.limbs[i] = r[i]; }

  // After the fold loop, value < 2p. One conditional subtract finishes the reduction.
  if (u256_geq(out, U256(P_LIMBS)) == 1u) {
    let s = u256_sub_raw(out, U256(P_LIMBS));
    out = s.diff;
  }
  return out;
}

fn fp_add(a: U256, b: U256) -> U256 {
  let s = u256_add_raw(a, b);
  // s can be up to 2p-2 + carry; reduce.
  if (s.carry == 1u || u256_geq(s.sum, U256(P_LIMBS)) == 1u) {
    let r = u256_sub_raw(s.sum, U256(P_LIMBS));
    return r.diff;
  }
  return s.sum;
}

fn fp_sub(a: U256, b: U256) -> U256 {
  let s = u256_sub_raw(a, b);
  if (s.borrow == 1u) {
    let r = u256_add_raw(s.diff, U256(P_LIMBS));
    return r.sum;
  }
  return s.diff;
}

fn fp_mul(a: U256, b: U256) -> U256 {
  let prod: U512 = u256_mul(a, b);
  return mod_p(prod);
}

fn fp_sqr(a: U256) -> U256 {
  return fp_mul(a, a);
}

// Modular inverse via Fermat: a^(p-2) mod p.
// p - 2 = 2^256 - 2^32 - 979. We do square-and-multiply on the bits of (p-2).
fn fp_inv(a: U256) -> U256 {
  // p - 2 limbs (LE):
  let exp: array<u32, 8> = array<u32, 8>(
    0xFFFFFC2Du, 0xFFFFFFFEu, 0xFFFFFFFFu, 0xFFFFFFFFu,
    0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu
  );
  var result: U256 = u256_one();
  var base: U256 = a;
  for (var limb: u32 = 0u; limb < 8u; limb = limb + 1u) {
    var word: u32 = exp[limb];
    for (var bit: u32 = 0u; bit < 32u; bit = bit + 1u) {
      if ((word & 1u) == 1u) {
        result = fp_mul(result, base);
      }
      base = fp_sqr(base);
      word = word >> 1u;
    }
  }
  return result;
}

fn fp_neg(a: U256) -> U256 {
  if (u256_is_zero(a)) { return a; }
  let r = u256_sub_raw(U256(P_LIMBS), a);
  return r.diff;
}

`;
