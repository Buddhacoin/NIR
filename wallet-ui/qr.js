// A small self-contained QR encoder for Version 5-L byte mode (up to 106 bytes per frame).
// It keeps payment payloads on-device and intentionally has no network dependency.
const SIZE = 37;
const DATA_CODEWORDS = 108;
const ECC_CODEWORDS = 26;
const QR_FRAME_PREFIX = "NIRQR1";
const FRAME_BYTES = 62;

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("QR-фрагмент содержит недопустимые символы.");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function encodePaymentQrFrames(text) {
  const bytes = new TextEncoder().encode(text);
  if (!bytes.length || bytes.length > 16_000) throw new Error("Размер QR-платежа недопустим.");
  const total = Math.ceil(bytes.length / FRAME_BYTES);
  return Array.from({ length: total }, (_, index) => {
    const chunk = bytes.slice(index * FRAME_BYTES, (index + 1) * FRAME_BYTES);
    return `${QR_FRAME_PREFIX}|${index + 1}|${total}|${bytesToBase64Url(chunk)}`;
  });
}

export function decodePaymentQrFrames(text) {
  const frames = String(text).trim().split(/\s+/).filter(Boolean);
  if (!frames.length || frames.length > 300) throw new Error("Не найден QR-платёж.");
  const chunks = new Map();
  let total = null;
  for (const frame of frames) {
    const matched = /^NIRQR1\|([1-9][0-9]{0,2})\|([1-9][0-9]{0,2})\|([A-Za-z0-9_-]+)$/.exec(frame);
    if (!matched) throw new Error("Формат QR-фрагмента неверен.");
    const index = Number(matched[1]);
    const declaredTotal = Number(matched[2]);
    if (declaredTotal > 300 || index > declaredTotal || (total !== null && total !== declaredTotal) || chunks.has(index)) {
      throw new Error("QR-фрагменты неполные или противоречивы.");
    }
    total = declaredTotal;
    chunks.set(index, base64UrlToBytes(matched[3]));
  }
  if (chunks.size !== total) throw new Error("Нужны все QR-фрагменты платёжного запроса.");
  const length = [...chunks.values()].reduce((sum, chunk) => sum + chunk.length, 0);
  if (length > 16_000) throw new Error("Размер QR-платежа недопустим.");
  const output = new Uint8Array(length);
  let offset = 0;
  for (let index = 1; index <= total; index += 1) {
    const chunk = chunks.get(index);
    if (!chunk) throw new Error("Нужны все QR-фрагменты платёжного запроса.");
    output.set(chunk, offset); offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}

function gfMultiply(a, b) {
  let value = 0;
  while (b) {
    if (b & 1) value ^= a;
    a = (a << 1) ^ (a & 0x80 ? 0x11d : 0);
    b >>>= 1;
  }
  return value;
}

function generator(degree) {
  let poly = [1]; let root = 1;
  for (let i = 0; i < degree; i += 1) {
    const next = Array(poly.length + 1).fill(0);
    poly.forEach((coefficient, index) => { next[index] ^= coefficient; next[index + 1] ^= gfMultiply(coefficient, root); });
    poly = next; root = gfMultiply(root, 2);
  }
  return poly.slice(1);
}

function errorCorrection(data) {
  const result = Array(ECC_CODEWORDS).fill(0); const poly = generator(ECC_CODEWORDS);
  for (const byte of data) {
    const factor = byte ^ result.shift(); result.push(0);
    poly.forEach((coefficient, index) => { result[index] ^= gfMultiply(coefficient, factor); });
  }
  return result;
}

function formatBits() {
  let value = 0b01000 << 10;
  for (let i = 14; i >= 10; i -= 1) if ((value >>> i) & 1) value ^= 0x537 << (i - 10);
  return ((0b01000 << 10) | value) ^ 0x5412;
}

function dataCodewords(text) {
  const payload = new TextEncoder().encode(text);
  if (payload.length > 106) throw new Error("QR-кадр слишком велик.");
  const bits = [0, 1, 0, 0];
  for (let i = 7; i >= 0; i -= 1) bits.push((payload.length >>> i) & 1);
  payload.forEach((byte) => { for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1); });
  for (let i = 0; i < Math.min(4, DATA_CODEWORDS * 8 - bits.length); i += 1) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => byte * 2 + bit, 0));
  for (let pad = 0; data.length < DATA_CODEWORDS; pad += 1) data.push(pad % 2 ? 0x11 : 0xec);
  return data;
}

function reserve(matrix, row, col, value) { if (row >= 0 && row < SIZE && col >= 0 && col < SIZE) matrix[row][col] = value; }
function finder(matrix, top, left) {
  for (let row = -1; row <= 7; row += 1) for (let col = -1; col <= 7; col += 1) {
    const edge = row === -1 || row === 7 || col === -1 || col === 7;
    const dark = !edge && (row === 0 || row === 6 || col === 0 || col === 6 || (row >= 2 && row <= 4 && col >= 2 && col <= 4));
    reserve(matrix, top + row, left + col, edge ? false : dark);
  }
}
function alignment(matrix, centerRow, centerCol) {
  for (let row = -2; row <= 2; row += 1) for (let col = -2; col <= 2; col += 1) {
    reserve(matrix, centerRow + row, centerCol + col, Math.max(Math.abs(row), Math.abs(col)) !== 1);
  }
}

export function qrMatrix(text) {
  const matrix = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  finder(matrix, 0, 0); finder(matrix, 0, SIZE - 7); finder(matrix, SIZE - 7, 0);
  alignment(matrix, 30, 30);
  for (let i = 8; i < SIZE - 8; i += 1) { reserve(matrix, 6, i, i % 2 === 0); reserve(matrix, i, 6, i % 2 === 0); }
  const format = formatBits();
  for (let i = 0; i < 15; i += 1) {
    const bit = ((format >>> i) & 1) === 1;
    reserve(matrix, i < 6 ? i : i < 8 ? i + 1 : SIZE - 15 + i, 8, bit);
    reserve(matrix, 8, i < 8 ? SIZE - i - 1 : i < 9 ? 15 - i : 15 - i - 1, bit);
  }
  reserve(matrix, SIZE - 8, 8, true);
  const stream = [...dataCodewords(text), ...errorCorrection(dataCodewords(text))]
    .flatMap((byte) => Array.from({ length: 8 }, (_, index) => (byte >>> (7 - index)) & 1));
  let offset = 0; let upward = true;
  for (let col = SIZE - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let step = 0; step < SIZE; step += 1) {
      const row = upward ? SIZE - 1 - step : step;
      for (let column = col; column >= col - 1; column -= 1) {
        if (matrix[row][column] !== null) continue;
        const bit = stream[offset++] ?? 0;
        matrix[row][column] = ((row + column) % 2 === 0) ? !bit : Boolean(bit);
      }
    }
    upward = !upward;
  }
  return matrix;
}

export function drawQr(canvas, text, label = "QR-код") {
  const matrix = qrMatrix(text); const scale = 6; const quiet = 4;
  canvas.width = canvas.height = (SIZE + quiet * 2) * scale;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#111";
  matrix.forEach((row, y) => row.forEach((dark, x) => { if (dark) context.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale); }));
  canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", label);
}
