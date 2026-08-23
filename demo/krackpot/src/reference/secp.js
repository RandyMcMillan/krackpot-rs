// CPU-side secp256k1 reference. Used to:
//   - Compute the per-chunk base public key
//   - Provide known-good values for test comparison
//   - Decode/encode helpers

export const P  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
export const N  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
export const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
export const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

const mod = (a, m = P) => {
  const r = a % m;
  return r < 0n ? r + m : r;
};

const modInv = (a, m = P) => {
  // Extended Euclidean
  let [g, x] = [m, 0n];
  let [g1, x1] = [mod(a, m), 1n];
  while (g1 !== 0n) {
    const q = g / g1;
    [g, g1] = [g1, g - q * g1];
    [x, x1] = [x1, x - q * x1];
  }
  if (g !== 1n) throw new Error("not invertible");
  return mod(x, m);
};

const pointAdd = (P1, P2) => {
  if (P1 === null) return P2;
  if (P2 === null) return P1;
  const [x1, y1] = P1;
  const [x2, y2] = P2;
  if (x1 === x2 && y1 !== y2) return null;
  let m;
  if (P1 === P2 || (x1 === x2 && y1 === y2)) {
    m = mod(3n * x1 * x1 * modInv(2n * y1));
  } else {
    m = mod((y2 - y1) * modInv(mod(x2 - x1)));
  }
  const x3 = mod(m * m - x1 - x2);
  const y3 = mod(m * (x1 - x3) - y1);
  return [x3, y3];
};

export const scalarMul = (k, point = [Gx, Gy]) => {
  let R = null;
  let Q = point;
  let kk = mod(k, N);
  while (kk > 0n) {
    if (kk & 1n) R = pointAdd(R, Q);
    Q = pointAdd(Q, Q);
    kk >>= 1n;
  }
  return R;
};

export const compressPubkey = (point) => {
  if (point === null) throw new Error("point at infinity");
  const [x, y] = point;
  const prefix = (y & 1n) === 0n ? 0x02 : 0x03;
  const xBytes = bigIntToBytesBE(x, 32);
  return new Uint8Array([prefix, ...xBytes]);
};

export const uncompressedPubkey = (point) => {
  if (point === null) throw new Error("point at infinity");
  const [x, y] = point;
  return new Uint8Array([0x04, ...bigIntToBytesBE(x, 32), ...bigIntToBytesBE(y, 32)]);
};

export const bigIntToBytesBE = (n, len) => {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(n & 0xFFn);
    n >>= 8n;
  }
  return out;
};

export const bytesToBigIntBE = (bytes) => {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
};

// Convert a u256 BigInt to 8 u32 limbs in little-endian order — matches WGSL buffer layout.
export const bigIntToLimbsLE = (n) => {
  const limbs = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    limbs[i] = Number(n & 0xFFFFFFFFn);
    n >>= 32n;
  }
  return limbs;
};

export const limbsLEToBigInt = (limbs) => {
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 32n) | BigInt(limbs[i]);
  return n;
};
