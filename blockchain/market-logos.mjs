// Token logos kept by NIR Markets itself: the first time a wallet page shows a token, its picture is
// fetched once (the coin's CoinGecko logo, the source's own picture, Trust Wallet's open assets
// catalogue, the token's site icon, in that order), checked to be a real raster image, saved on
// the server and served from /market/logo/<network>/<contract | native-SYMBOL> from then on, so
// the pages do not depend on any outside service for pictures.
//
// GET /market/logo/<network>/<0x… contract | native-SYMBOL>  → the picture (PNG, JPEG, WebP or GIF)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY = /^(?:0x[0-9a-f]{40}|native-[A-Z0-9]{1,12})$/;
const NETWORK = /^[a-z]{2,12}$/;
const KINDS = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
];
// What kind of picture the bytes are, or null when they are not one we serve.
export function pictureKind(bytes) {
  if (bytes.length > 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return KINDS.find(([, magic]) => magic.every((byte, index) => bytes[index] === byte))?.[0] ?? null;
}

// --- Keccak-256, for the mixed-case (checksummed) addresses the assets catalogue is keyed by.
const ROUNDS = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROTATE = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const MASK = (1n << 64n) - 1n;
const rotl = (value, shift) => (shift ? ((value << BigInt(shift)) | (value >> BigInt(64 - shift))) & MASK : value);
export function keccak256(input) {
  const rate = 136;
  const bytes = [...input, 0x01];
  while (bytes.length % rate) bytes.push(0);
  bytes[bytes.length - 1] |= 0x80;
  const state = new Array(25).fill(0n);
  for (let offset = 0; offset < bytes.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte -= 1) value = (value << 8n) | BigInt(bytes[offset + lane * 8 + byte]);
      state[lane] ^= value;
    }
    for (const round of ROUNDS) {
      const column = [0, 1, 2, 3, 4].map((x) => state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]);
      for (let x = 0; x < 5; x += 1) {
        const mix = column[(x + 4) % 5] ^ rotl(column[(x + 1) % 5], 1);
        for (let y = 0; y < 25; y += 5) state[x + y] ^= mix;
      }
      const moved = new Array(25);
      for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) moved[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], ROTATE[x + 5 * y]);
      for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) state[x + 5 * y] = moved[x + 5 * y] ^ (~moved[(x + 1) % 5 + 5 * y] & MASK & moved[(x + 2) % 5 + 5 * y]);
      state[0] ^= round;
    }
  }
  const out = [];
  for (let lane = 0; lane < 4; lane += 1) for (let byte = 0; byte < 8; byte += 1) out.push(Number((state[lane] >> BigInt(8 * byte)) & 0xffn));
  return Buffer.from(out);
}
// 0xabc… → 0xAbC…, as the catalogue spells it.
export function checksum(address) {
  const lower = address.toLowerCase().slice(2);
  const hash = keccak256(Buffer.from(lower, "latin1")).toString("hex");
  return `0x${[...lower].map((char, index) => (parseInt(hash[index], 16) >= 8 ? char.toUpperCase() : char)).join("")}`;
}

async function fetchPicture(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "follow" });
  if (!response.ok) throw Object.assign(new Error(`picture answered ${response.status}`), { status: response.status });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 300_000) throw new Error("picture too large");
  return bytes;
}

// `dir`: where pictures are kept; `catalogue(network)`: the assets catalogue's folder for a network.
export function createLogos({ dir, fetchBytes = fetchPicture, now = Date.now, catalogue = () => null } = {}) {
  if (dir) mkdirSync(dir, { recursive: true });
  const candidates = new Map(); // "network/key" → picture addresses to try, best first
  const missing = new Map(); // "network/key" → time before which it is not looked for again
  const pending = new Map();
  const file = (network, key) => join(dir, `${network}-${key}.img`);

  // The page's address for a token's picture; the sources it may come from are noted for the first ask.
  function url(network, address, symbol, sources) {
    if (!dir || !NETWORK.test(network)) return sources.find(Boolean) ?? null;
    const key = address ? address.toLowerCase() : `native-${String(symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12)}`;
    if (!KEY.test(key)) return sources.find(Boolean) ?? null;
    const id = `${network}/${key}`;
    const list = sources.filter((source) => /^https:\/\//.test(source ?? ""));
    if (list.length) candidates.set(id, [...new Set([...list, ...(candidates.get(id) ?? [])])].slice(0, 4));
    if (candidates.size > 50_000) candidates.delete(candidates.keys().next().value);
    return `/market/logo/${id}`;
  }

  async function picture(network, key) {
    const id = `${network}/${key}`;
    const path = file(network, key);
    if (existsSync(path)) return readFileSync(path);
    if ((missing.get(id) ?? 0) > now()) return null;
    if (pending.has(id)) return pending.get(id);
    const job = (async () => {
      const folder = catalogue(network);
      const tries = [...(candidates.get(id) ?? []),
        ...(folder && key.startsWith("0x") ? [`https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${folder}/assets/${checksum(key)}/logo.png`] : [])];
      for (const source of tries) {
        try {
          const bytes = await fetchBytes(source);
          if (!pictureKind(bytes)) continue;
          writeFileSync(path, bytes);
          return bytes;
        } catch {}
      }
      missing.set(id, now() + 86_400_000);
      if (missing.size > 50_000) missing.delete(missing.keys().next().value);
      return null;
    })();
    pending.set(id, job);
    try { return await job; } finally { pending.delete(id); }
  }

  // Answers GET /market/logo/…, or returns false.
  async function handle(request, response, url) {
    const match = /^\/market\/logo\/([a-z]{2,12})\/([^/]+)$/.exec(url.pathname);
    if (!match || !dir) return false;
    const [, network, raw] = match;
    const key = raw.startsWith("0x") ? raw.toLowerCase() : raw;
    const bytes = request.method === "GET" && NETWORK.test(network) && KEY.test(key) ? await picture(network, key) : null;
    if (!bytes) {
      response.writeHead(404, { "content-type": "text/plain", "cache-control": "public, max-age=3600" });
      response.end("no picture");
      return true;
    }
    response.writeHead(200, { "content-type": pictureKind(bytes), "cache-control": "public, max-age=2592000, immutable",
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" });
    response.end(bytes);
    return true;
  }
  return { url, handle, picture };
}
