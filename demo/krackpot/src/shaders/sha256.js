// SHA-256 in WGSL. Single-block (≤55-byte) variant — sufficient for the 33-byte
// compressed-pubkey input used in the puzzle search. Multi-block hashing can be
// added later if a use case appears.

export const sha256WGSL = /* wgsl */ `

const SHA_K: array<u32, 64> = array<u32, 64>(
  0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
  0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
  0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
  0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
  0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
  0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
  0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
  0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
);

fn rotr32(x: u32, n: u32) -> u32 {
  return (x >> n) | (x << (32u - n));
}

fn sha256_compress(state: ptr<function, array<u32, 8>>, block: ptr<function, array<u32, 16>>) {
  var W: array<u32, 64>;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) { W[i] = (*block)[i]; }
  for (var i: u32 = 16u; i < 64u; i = i + 1u) {
    let s0 = rotr32(W[i - 15u], 7u) ^ rotr32(W[i - 15u], 18u) ^ (W[i - 15u] >> 3u);
    let s1 = rotr32(W[i - 2u], 17u) ^ rotr32(W[i - 2u], 19u) ^ (W[i - 2u] >> 10u);
    W[i] = W[i - 16u] + s0 + W[i - 7u] + s1;
  }
  var a = (*state)[0]; var b = (*state)[1]; var c = (*state)[2]; var d = (*state)[3];
  var e = (*state)[4]; var f = (*state)[5]; var g = (*state)[6]; var h = (*state)[7];
  for (var i: u32 = 0u; i < 64u; i = i + 1u) {
    let S1 = rotr32(e, 6u) ^ rotr32(e, 11u) ^ rotr32(e, 25u);
    let ch = (e & f) ^ (~e & g);
    let t1 = h + S1 + ch + SHA_K[i] + W[i];
    let S0 = rotr32(a, 2u) ^ rotr32(a, 13u) ^ rotr32(a, 22u);
    let maj = (a & b) ^ (a & c) ^ (b & c);
    let t2 = S0 + maj;
    h = g; g = f; f = e;
    e = d + t1;
    d = c; c = b; b = a;
    a = t1 + t2;
  }
  (*state)[0] = (*state)[0] + a; (*state)[1] = (*state)[1] + b;
  (*state)[2] = (*state)[2] + c; (*state)[3] = (*state)[3] + d;
  (*state)[4] = (*state)[4] + e; (*state)[5] = (*state)[5] + f;
  (*state)[6] = (*state)[6] + g; (*state)[7] = (*state)[7] + h;
}

// SHA-256 of byte_len bytes packed into 14 BE u32 words. byte_len must be ≤ 55.
// Caller: bytes[i] = (b[4i]<<24) | (b[4i+1]<<16) | (b[4i+2]<<8) | b[4i+3]
// Bytes past byte_len are ignored (we mask + apply 0x80 padding ourselves).
fn sha256_short(bytes: array<u32, 14>, byte_len: u32) -> array<u32, 8> {
  var block: array<u32, 16>;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) { block[i] = 0u; }

  // Copy whole words.
  let full_words = byte_len / 4u;
  for (var i: u32 = 0u; i < full_words; i = i + 1u) { block[i] = bytes[i]; }

  // Place 0x80 marker in the partial word at byte position (byte_len % 4),
  // keeping the (byte_len % 4) bytes already there from the input.
  let pad_pos = byte_len % 4u;
  // kept_mask covers the top (pad_pos * 8) bits. Avoid the pad_pos == 0 shift-by-32 UB
  // by formulating the mask via a left-shift of 0xFFFFFF00.
  let kept_mask = 0xFFFFFF00u << ((3u - pad_pos) * 8u);
  let kept = bytes[full_words] & kept_mask;
  let marker = 0x80u << ((3u - pad_pos) * 8u);
  block[full_words] = kept | marker;

  // Length in bits, big-endian, in last 8 bytes of block.
  block[14] = 0u;
  block[15] = byte_len * 8u;

  var state: array<u32, 8> = array<u32, 8>(
    0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
    0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u
  );
  sha256_compress(&state, &block);
  return state;
}
`;
