// RIPEMD-160 reference, byte-in / byte-out.

const rol = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;

const F = (j, x, y, z) => {
  if (j < 16) return (x ^ y ^ z) >>> 0;
  if (j < 32) return ((x & y) | (~x & z)) >>> 0;
  if (j < 48) return ((x | ~y) ^ z) >>> 0;
  if (j < 64) return ((x & z) | (y & ~z)) >>> 0;
  return (x ^ (y | ~z)) >>> 0;
};

const K  = [0x00000000, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E];
const KP = [0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0x00000000];

const R  = [
   0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15,
   7,  4, 13,  1, 10,  6, 15,  3, 12,  0,  9,  5,  2, 14, 11,  8,
   3, 10, 14,  4,  9, 15,  8,  1,  2,  7,  0,  6, 13, 11,  5, 12,
   1,  9, 11, 10,  0,  8, 12,  4, 13,  3,  7, 15, 14,  5,  6,  2,
   4,  0,  5,  9,  7, 12,  2, 10, 14,  1,  3,  8, 11,  6, 15, 13,
];
const RP = [
   5, 14,  7,  0,  9,  2, 11,  4, 13,  6, 15,  8,  1, 10,  3, 12,
   6, 11,  3,  7,  0, 13,  5, 10, 14, 15,  8, 12,  4,  9,  1,  2,
  15,  5,  1,  3,  7, 14,  6,  9, 11,  8, 12,  2, 10,  0,  4, 13,
   8,  6,  4,  1,  3, 11, 15,  0,  5, 12,  2, 13,  9,  7, 10, 14,
  12, 15, 10,  4,  1,  5,  8,  7,  6,  2, 13, 14,  0,  3,  9, 11,
];
const S  = [
  11, 14, 15, 12,  5,  8,  7,  9, 11, 13, 14, 15,  6,  7,  9,  8,
   7,  6,  8, 13, 11,  9,  7, 15,  7, 12, 15,  9, 11,  7, 13, 12,
  11, 13,  6,  7, 14,  9, 13, 15, 14,  8, 13,  6,  5, 12,  7,  5,
  11, 12, 14, 15, 14, 15,  9,  8,  9, 14,  5,  6,  8,  6,  5, 12,
   9, 15,  5, 11,  6,  8, 13, 12,  5, 12, 13, 14, 11,  8,  5,  6,
];
const SP = [
   8,  9,  9, 11, 13, 15, 15,  5,  7,  7,  8, 11, 14, 14, 12,  6,
   9, 13, 15,  7, 12,  8,  9, 11,  7,  7, 12,  7,  6, 15, 13, 11,
   9,  7, 15, 11,  8,  6,  6, 14, 12, 13,  5, 14, 13, 13,  7,  5,
  15,  5,  8, 11, 14, 14,  6, 14,  6,  9, 12,  9, 12,  5, 15,  8,
   8,  5, 12,  9, 12,  5, 14,  6,  8, 13,  6,  5, 15, 13, 11, 11,
];

export const ripemd160 = (bytes) => {
  // Pad: append 0x80, then zeros, length in bits as 64-bit LE at the end.
  const bitLen = BigInt(bytes.length) * 8n;
  const padLen = ((bytes.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  for (let i = 0; i < 8; i++) {
    buf[padLen - 8 + i] = Number((bitLen >> BigInt(i * 8)) & 0xFFn);
  }

  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;

  for (let off = 0; off < padLen; off += 64) {
    const X = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      X[i] = (buf[off + i*4]) |
             (buf[off + i*4 + 1] << 8) |
             (buf[off + i*4 + 2] << 16) |
             (buf[off + i*4 + 3] << 24);
      X[i] >>>= 0;
    }

    let A = h0, B = h1, C = h2, D = h3, E = h4;
    let Ap = h0, Bp = h1, Cp = h2, Dp = h3, Ep = h4;

    for (let j = 0; j < 80; j++) {
      const round = j >> 4;
      let T = (A + F(j, B, C, D) + X[R[j]] + K[round]) >>> 0;
      T = (rol(T, S[j]) + E) >>> 0;
      A = E; E = D; D = rol(C, 10); C = B; B = T;

      let Tp = (Ap + F(79 - j, Bp, Cp, Dp) + X[RP[j]] + KP[round]) >>> 0;
      Tp = (rol(Tp, SP[j]) + Ep) >>> 0;
      Ap = Ep; Ep = Dp; Dp = rol(Cp, 10); Cp = Bp; Bp = Tp;
    }

    const T = (h1 + C + Dp) >>> 0;
    h1 = (h2 + D + Ep) >>> 0;
    h2 = (h3 + E + Ap) >>> 0;
    h3 = (h4 + A + Bp) >>> 0;
    h4 = (h0 + B + Cp) >>> 0;
    h0 = T;
  }

  const out = new Uint8Array(20);
  const writeLE = (off, v) => {
    out[off]     = v & 0xFF;
    out[off + 1] = (v >>> 8) & 0xFF;
    out[off + 2] = (v >>> 16) & 0xFF;
    out[off + 3] = (v >>> 24) & 0xFF;
  };
  writeLE(0,  h0);
  writeLE(4,  h1);
  writeLE(8,  h2);
  writeLE(12, h3);
  writeLE(16, h4);
  return out;
};
