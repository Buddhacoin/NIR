const HASH = /^[0-9a-f]{64}$/;

function exactOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash ||
      (url.protocol === "http:" && !["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new Error("node URL must be an exact HTTP origin");
  }
  return url.origin;
}

function exactLoopbackSubmissionOrigin(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("wallet submission origin is invalid");
  let url;
  try { url = new URL(value); }
  catch { throw new Error("wallet submission requires an exact loopback HTTP origin"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port || Number(url.port) < 1 || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash || url.origin !== value) {
    throw new Error("wallet submission requires an exact loopback HTTP origin");
  }
  return url.origin;
}

export function normalizeNodePolicy(value) {
  if (!value || !Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > 16 ||
      !Number.isSafeInteger(value.minimumAgreement) || value.minimumAgreement < 1 ||
      value.minimumAgreement > value.nodes.length) {
    throw new Error("wallet node policy is invalid");
  }
  const nodes = value.nodes.map(exactOrigin);
  if (new Set(nodes).size !== nodes.length) throw new Error("wallet nodes must be unique");
  return { minimumAgreement: value.minimumAgreement, nodes,
    submissionOrigin: exactLoopbackSubmissionOrigin(value.submissionOrigin) };
}

export function transactionSubmissionUrl(policy) {
  if (!policy?.submissionOrigin) throw new Error("Локальный адрес отправки транзакций не настроен.");
  return `${exactLoopbackSubmissionOrigin(policy.submissionOrigin)}/v1/transactions`;
}

export function selectNodeHealth(entries, {
  expectedNetworkId = null,
  minimumAgreement = 1,
  minimumHeight = 0,
  trustedTipHash = null,
} = {}) {
  if (!Array.isArray(entries) || entries.length > 16 ||
      !Number.isSafeInteger(minimumAgreement) || minimumAgreement < 1 ||
      !Number.isSafeInteger(minimumHeight) || minimumHeight < 0 ||
      (trustedTipHash !== null && !HASH.test(trustedTipHash))) {
    throw new Error("node selection policy is invalid");
  }
  const valid = [];
  const origins = new Set();
  for (const entry of entries) {
    try {
      const url = exactOrigin(entry?.url);
      const health = entry?.health;
      if (origins.has(url) || !health || health.status !== "ready" ||
          typeof health.networkId !== "string" ||
          health.networkId.length < 3 || health.networkId.length > 128 ||
          !Number.isSafeInteger(health.height) || health.height < minimumHeight ||
          !HASH.test(health.tipHash ?? "") ||
          (trustedTipHash !== null && health.height === minimumHeight &&
           health.tipHash !== trustedTipHash) ||
          (expectedNetworkId !== null && health.networkId !== expectedNetworkId)) {
        throw new Error("invalid node health");
      }
      origins.add(url);
      valid.push({ health: structuredClone(health), url });
    } catch {
      // An unavailable, duplicate, foreign, or malformed node is not a candidate.
    }
  }
  const tips = new Map();
  for (const { health } of valid) {
    const key = `${health.networkId}:${health.height}`;
    const known = tips.get(key);
    if (known && known !== health.tipHash) {
      throw new Error("nodes report conflicting finalized hashes at the same height");
    }
    tips.set(key, health.tipHash);
  }
  const groups = new Map();
  for (const entry of valid) {
    const key = `${entry.health.networkId}:${entry.health.height}:${entry.health.tipHash}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const accepted = [...groups.values()].filter((group) => group.length >= minimumAgreement)
    .sort((left, right) => right[0].health.height - left[0].health.height ||
      left[0].url.localeCompare(right[0].url));
  if (accepted.length === 0) {
    throw new Error(`node agreement is insufficient (required ${minimumAgreement})`);
  }
  const selected = accepted[0].sort((left, right) => left.url.localeCompare(right.url));
  return {
    agreeingNodes: selected.length,
    availableNodes: valid.length,
    health: structuredClone(selected[0].health),
    url: selected[0].url,
  };
}
