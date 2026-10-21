// Checksummed NIR addresses for people and exchanges, in the style of
// EIP-55: the address stays `nir1` + 64 hex digits, and each hex
// letter is printed upper- or lower-case by one bit of
// SHA-256("NIR/ADDRESS-CASE/v1\0" + lower-case address). A mistyped letter
// or digit then almost never matches the case pattern. The chain and every
// signed object keep using the lower-case address.

const PREFIX = "nir1";
const DOMAIN = "NIR/ADDRESS-CASE/v1\0";
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// SHA-256 of an ASCII string, synchronous so pages can check as you type.
function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(length);
  data.set(bytes);
  data[bytes.length] = 0x80;
  new DataView(data.buffer).setUint32(length - 4, bytes.length * 8);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const view = new DataView(data.buffer);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      [k, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    const next = [a, b, c, d, e, f, g, k];
    for (let i = 0; i < 8; i++) h[i] = (h[i] + next[i]) >>> 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) new DataView(out.buffer).setUint32(i * 4, h[i]);
  return out;
}

export function checksumAddress(address) {
  if (!/^nir1[0-9a-f]{64}$/.test(address)) throw new Error("Адрес NIR неверен.");
  const hash = sha256(DOMAIN + address);
  let result = PREFIX;
  for (let i = 0; i < 64; i++) {
    const character = address[PREFIX.length + i];
    const upper = (hash[i >> 3] >> (7 - (i & 7))) & 1;
    result += upper && character >= "a" ? character.toUpperCase() : character;
  }
  return result;
}

// Reads an address someone typed or pasted. Returns the lower-case address
// the chain uses and whether its checksum was present. A mixed-case address
// whose case pattern is wrong is a typo and is refused.
export function parseAddress(input) {
  const text = typeof input === "string" ? input.trim() : "";
  if (!/^nir1[0-9a-fA-F]{64}$/.test(text)) throw new Error("Адрес NIR неверен.");
  const address = text.toLowerCase();
  const hex = text.slice(PREFIX.length);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return { address, checked: false };
  if (checksumAddress(address) !== text) {
    throw new Error("В адресе опечатка: контрольная сумма не сходится. Скопируйте адрес заново.");
  }
  return { address, checked: true };
}
