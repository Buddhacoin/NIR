import { SUPPORTED_TRANSACTION_TYPES } from "./transaction-decoder.js";

export const OFFLINE_PACKAGE_FORMAT = "nir-offline-signing-package-v1";
export const OFFLINE_SIGNED_FORMAT = "nir-offline-signed-package-v1";
export const OFFLINE_PACKAGE_VERSION = 1;
const HASH = /^[0-9a-f]{64}$/;
const MAX_PACKAGE_BYTES = 128 * 1024;
const MAX_LIFETIME_MS = 15 * 60_000;

function fail(message) { throw new Error(`Офлайн-пакет отклонён: ${message}`); }
function object(value, name) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} имеет неверный формат`); return value; }
function exact(value, allowed, name) {
  const item = object(value, name); const keys = Object.keys(item);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) fail(`${name} содержит неизвестное или пропущенное поле`);
  return item;
}
function json(value, depth = 0) {
  if (depth > 20) fail("вложенность пакета слишком велика");
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  if (Array.isArray(value)) { if (value.length > 512) fail("массив пакета слишком велик"); value.forEach((entry) => json(entry, depth + 1)); return; }
  if (typeof value === "object") { if (Object.keys(value).length > 128) fail("объект пакета слишком велик"); Object.values(value).forEach((entry) => json(entry, depth + 1)); return; }
  fail("пакет содержит недопустимое значение");
}
export function canonicalJson(value) {
  json(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function checkpoint(value, networkId) {
  const checked = exact(value, ["height", "networkId", "stateRoot", "tipHash", "validatorSetId"], "checkpoint");
  if (checked.networkId !== networkId || !Number.isSafeInteger(checked.height) || checked.height < 0 || !HASH.test(checked.tipHash ?? "") || !HASH.test(checked.stateRoot ?? "") || !HASH.test(checked.validatorSetId ?? "")) fail("checkpoint недопустим");
  return checked;
}
function intent(value, networkId) {
  const checked = object(value, "намерение");
  if (!SUPPORTED_TRANSACTION_TYPES.has(checked.type) || checked.networkId !== networkId) fail("тип или сеть намерения недопустимы");
  json(checked); return checked;
}

/** Browser structure guard. The local public verifier re-runs the domain-separated commitment. */
export function validateOfflineSigningPackage(value, { now = Date.now() } = {}) {
  const packet = exact(value, ["checkpoint", "createdAt", "expiresAt", "format", "intent", "networkId", "simulation", "simulationCommitment", "version"], "пакет");
  if (packet.format !== OFFLINE_PACKAGE_FORMAT || packet.version !== OFFLINE_PACKAGE_VERSION || typeof packet.networkId !== "string" || !packet.networkId || !Number.isSafeInteger(packet.createdAt) || !Number.isSafeInteger(packet.expiresAt) || packet.expiresAt <= now || packet.expiresAt <= packet.createdAt || packet.expiresAt > packet.createdAt + MAX_LIFETIME_MS || !HASH.test(packet.simulationCommitment ?? "")) fail("версия, срок или commitment пакета недопустимы");
  const checkedCheckpoint = checkpoint(packet.checkpoint, packet.networkId); const checkedIntent = intent(packet.intent, packet.networkId);
  const simulation = exact(packet.simulation, ["result", "stateEvidence"], "симуляция"); const result = object(simulation.result, "результат симуляции"); const evidence = object(simulation.stateEvidence, "доказательство состояния");
  if (result.networkId !== packet.networkId || result.type !== checkedIntent.type || canonicalJson(result.intent) !== canonicalJson(checkedIntent) || result.stateHeight !== checkedCheckpoint.height || result.proof?.tipHash !== checkedCheckpoint.tipHash || result.proof?.stateRoot !== checkedCheckpoint.stateRoot || evidence.networkId !== packet.networkId || evidence.height !== checkedCheckpoint.height || evidence.tipHash !== checkedCheckpoint.tipHash || evidence.stateRoot !== checkedCheckpoint.stateRoot) fail("симуляция не соответствует намерению или checkpoint");
  json(simulation); if (new TextEncoder().encode(canonicalJson(packet)).length > MAX_PACKAGE_BYTES) fail("пакет слишком велик"); return structuredClone(packet);
}

export function validateOfflineSignedEnvelope(value, { now = Date.now(), expected = null } = {}) {
  const envelope = exact(value, ["checkpoint", "createdAt", "format", "networkId", "package", "signingPackageHash", "transaction", "version"], "подписанный пакет");
  if (envelope.format !== OFFLINE_SIGNED_FORMAT || envelope.version !== OFFLINE_PACKAGE_VERSION || !Number.isSafeInteger(envelope.createdAt) || envelope.networkId !== envelope.package?.networkId || !HASH.test(envelope.signingPackageHash ?? "")) fail("версия или hash подписанного пакета недопустимы");
  const packet = validateOfflineSigningPackage(envelope.package, { now }); const checkedCheckpoint = checkpoint(envelope.checkpoint, packet.networkId);
  if (canonicalJson(checkedCheckpoint) !== canonicalJson(packet.checkpoint)) fail("checkpoint подписи не совпадает с пакетом");
  if (expected && (packet.networkId !== expected.networkId || packet.simulationCommitment !== expected.simulationCommitment || canonicalJson(packet.intent) !== canonicalJson(expected.intent))) fail("подписанный пакет не относится к показанной симуляции");
  const transaction = object(envelope.transaction, "подписанная операция"); for (const [key, expectedValue] of Object.entries(packet.intent)) if (transaction[key] !== expectedValue) fail(`подписанная операция изменила поле ${key}`);
  json(transaction); return { packet, transaction: structuredClone(transaction), signingPackageHash: envelope.signingPackageHash };
}

export function encodeOfflineQrFrames(serialized, frameSize = 700) {
  if (typeof serialized !== "string" || !serialized || new TextEncoder().encode(serialized).length > MAX_PACKAGE_BYTES || !Number.isSafeInteger(frameSize) || frameSize < 120 || frameSize > 900) fail("данные для QR недопустимы");
  const encoded = btoa(unescape(encodeURIComponent(serialized))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); const total = Math.ceil(encoded.length / frameSize); if (total > 256) fail("слишком много QR-фрагментов");
  return Array.from({ length: total }, (_, index) => `NIRQR1/${index + 1}/${total}/${encoded.slice(index * frameSize, (index + 1) * frameSize)}`);
}
export function decodeOfflineQrFrames(text) {
  if (typeof text !== "string" || text.length > MAX_PACKAGE_BYTES * 3) fail("QR-данные недопустимы");
  const parts = text.trim().split(/\s+/).filter(Boolean).map((entry) => { const match = /^NIRQR1\/(\d{1,3})\/(\d{1,3})\/([A-Za-z0-9_-]{1,1200})$/.exec(entry); if (!match) fail("формат QR-фрагмента неизвестен"); return { index: Number(match[1]), total: Number(match[2]), data: match[3] }; });
  if (!parts.length || parts.length > 256 || parts.some(({ index, total }) => index < 1 || index > total || total !== parts[0].total) || new Set(parts.map(({ index }) => index)).size !== parts.length || parts.length !== parts[0].total) fail("QR-фрагменты неполны или повторяются");
  const encoded = parts.sort((a, b) => a.index - b.index).map(({ data }) => data).join(""); let decoded; try { decoded = decodeURIComponent(escape(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")))); } catch { fail("QR-фрагменты повреждены"); }
  if (new TextEncoder().encode(decoded).length > MAX_PACKAGE_BYTES) fail("собранный QR-пакет недопустим"); return decoded;
}
