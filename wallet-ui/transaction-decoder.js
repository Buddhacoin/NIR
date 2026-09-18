const ATOMIC = /^(0|[1-9][0-9]*)$/;
const DELTA = /^-?(0|[1-9][0-9]*)$/;

export const SUPPORTED_TRANSACTION_TYPES = new Set([
  "transfer", "credit-stake", "credit-delegation", "credit-unstake-request", "credit-unstake-claim", "payment-request",
  "asset-create", "asset-mint", "asset-transfer", "asset-burn", "asset-revoke-authority",
]);

function fail(message) { throw new Error(`Симуляция отклонена: ${message}`); }
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} имеет неверный формат`);
  return value;
}
function atomic(value, name) {
  if (typeof value !== "string" || !ATOMIC.test(value)) fail(`${name} должен быть atomic NIR`);
  return value;
}
function string(value, name, max = 512) {
  if (typeof value !== "string" || !value || value.length > max) fail(`${name} имеет неверный формат`);
  return value;
}
function sameIntent(intent, echoed) {
  const value = object(echoed, "повторённое намерение");
  for (const [key, expected] of Object.entries(intent)) {
    if (value[key] !== expected) fail(`параметр ${key} не совпадает с намерением`);
  }
}
function authority(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) fail("нет списка полномочий");
  return value.map((entry) => {
    const item = object(entry, "полномочие");
    if (item.required !== true) fail("полномочие не требует явной подписи");
    return { address: string(item.address, "адрес полномочия", 128), role: string(item.role, "роль полномочия", 128) };
  });
}
function safeResource(value) {
  const item = object(value, "изменение ресурса");
  const role = string(item.role, "роль ресурса", 128);
  const copy = {};
  for (const [key, field] of Object.entries(item)) {
    if (!["role", "address", "owner", "delegate", "unit", "before", "after"].includes(key)) fail("ресурс содержит неизвестное поле");
    if (field === null || typeof field === "string" || typeof field === "number") copy[key] = field;
    else if (key === "before" || key === "after") {
      const nested = object(field, "состояние ресурса");
      if (Object.keys(nested).length > 8 || Object.values(nested).some((entry) =>
        !["string", "number", "boolean"].includes(typeof entry) && entry !== null)) fail("состояние ресурса слишком сложно");
      copy[key] = nested;
    } else fail("ресурс содержит неподдерживаемое вложенное значение");
  }
  return { role, details: JSON.stringify(copy) };
}
function safeAsset(value) {
  const item = object(value, "изменение актива");
  const allowed = new Set(["assetId", "holder", "balanceBefore", "balanceAfter", "supplyBefore",
    "supplyAfter", "mintedAfter", "authorityBefore", "authorityAfter"]);
  const copy = {};
  for (const [key, field] of Object.entries(item)) {
    if (!allowed.has(key) || (field !== null && typeof field !== "string")) fail("актив содержит неизвестное поле");
    copy[key] = field;
  }
  string(copy.assetId, "asset id", 64);
  return { role: "asset", details: JSON.stringify(copy), ...copy };
}

/** Fail closed: no verified proof, intent mismatch, or new operation type reaches signing. */
export function decodeVerifiedSimulation(result, intent) {
  const response = object(result, "ответ bridge");
  if (response.verified !== true) fail("bridge не подтвердил доказательство состояния");
  const simulation = object(response.simulation, "симуляция");
  const type = string(simulation.type, "тип операции", 80);
  if (!SUPPORTED_TRANSACTION_TYPES.has(type) || type !== intent.type) fail("тип операции неизвестен или не совпадает с намерением");
  sameIntent(intent, simulation.intent);
  if (simulation.networkId !== intent.networkId) fail("идентификатор сети не совпадает");
  if (!simulation.proof || simulation.proof.verified !== true || !Number.isSafeInteger(simulation.stateHeight) || simulation.stateHeight < 0) {
    fail("нет доказанного состояния сети");
  }
  const deltas = object(simulation.deltas, "изменения состояния");
  if (!Array.isArray(deltas.balance) || !Array.isArray(deltas.resources) || !Array.isArray(deltas.nonce)) fail("неполный список изменений");
  const balance = deltas.balance.map((entry) => {
    const item = object(entry, "изменение баланса");
    if (item.address !== null) string(item.address, "адрес изменения", 128);
    if (typeof item.atomicDelta !== "string" || !DELTA.test(item.atomicDelta)) fail("дельта баланса неверна");
    return { address: item.address, delta: item.atomicDelta, role: string(item.role, "роль изменения", 128) };
  });
  const fee = object(deltas.fee, "комиссия");
  const feeAmount = atomic(fee.atomic, "комиссия");
  if (fee.payer !== null) string(fee.payer, "плательщик комиссии", 128);
  const nonces = deltas.nonce.map((entry) => {
    const item = object(entry, "nonce");
    if (!Number.isSafeInteger(item.before) || !Number.isSafeInteger(item.after) || item.after !== item.before + 1) fail("nonce неверен");
    return { address: string(item.address, "адрес nonce", 128), before: item.before, after: item.after, role: string(item.role, "роль nonce", 128) };
  });
  const risks = Array.isArray(simulation.risks) ? simulation.risks.map((risk) => string(risk, "риск", 400)) : fail("нет списка рисков");
  const assetChanges = deltas.asset === undefined ? [] :
    Array.isArray(deltas.asset) ? deltas.asset.map(safeAsset) : fail("изменения актива имеют неверный формат");
  if (type.startsWith("asset-") && assetChanges.length === 0) fail("нет изменений актива");
  return { type, networkId: simulation.networkId, stateHeight: simulation.stateHeight, intent: simulation.intent,
    proof: simulation.proof, authority: authority(simulation.authority), fee: { amount: feeAmount, payer: fee.payer },
    balance, assets: assetChanges, resources: deltas.resources.map(safeResource), nonces, risks, simulationId: string(simulation.simulationId, "идентификатор симуляции", 128) };
}
