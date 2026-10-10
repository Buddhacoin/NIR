import { createHash } from "node:crypto";
import { addressFromPublicKey, canonicalJson, signObject, verifyObject } from "./crypto.mjs";

const DOMAIN = "NIR_MODEL_LAB_LOCAL_IRIS_RECEIPT_V1";
const FORMAT = "nir-local-iris-run-receipt-v1";
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]{64}$/;

export function irisEvidenceDigest(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 1_000_000)
    throw new Error("invalid Iris evidence bytes");
  return createHash("sha256").update("NIR_LOCAL_IRIS_EVIDENCE_BYTES_V1\0")
    .update(bytes).digest("hex");
}

function evidenceMatchesBundle(bytes, bundleHash) {
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    return parsed?.format === "nir-local-iris-evidence-v1" &&
      parsed.summary?.status === "pinned-local-model-evaluation" &&
      parsed.summary?.scope === "local-public-iris-example-only" &&
      parsed.summary?.bundleHash === bundleHash &&
      parsed.bundle?.bundle_hash === bundleHash &&
      parsed.summary?.bundleVerified === true &&
      parsed.summary?.networkSubmitted === false &&
      parsed.summary?.rewardCredited === false &&
      parsed.summary?.independentOperators === false &&
      parsed.summary?.hiddenChallenges === false &&
      parsed.summary?.energyAttested === false &&
      parsed.summary?.walletChanged === false;
  } catch { return false; }
}

export function createLocalIrisRunIntent({ recipient, nonce, bundleHash, evidenceBytes }) {
  if (!ADDRESS.test(recipient ?? "") || !HEX.test(nonce ?? "") ||
      !HEX.test(bundleHash ?? "") || !evidenceMatchesBundle(evidenceBytes, bundleHash))
    throw new Error("invalid local Iris run identity or evidence");
  return {
    format: FORMAT, scope: "local-rehearsal-only", model: "pinned-iris-linear-v1",
    recipient, nonce, bundleHash, evidenceDigest: irisEvidenceDigest(evidenceBytes),
    networkId: null, genesisHash: null, networkSubmitted: false,
    rewardEligible: false, executionVerified: false,
  };
}

function validIntent(intent) {
  return intent && typeof intent === "object" && !Array.isArray(intent) &&
    Object.keys(intent).sort().join(",") === ["format", "scope", "model", "recipient",
      "nonce", "bundleHash", "evidenceDigest", "networkId", "genesisHash",
      "networkSubmitted", "rewardEligible", "executionVerified"].sort().join(",") &&
    intent.format === FORMAT && intent.scope === "local-rehearsal-only" &&
    intent.model === "pinned-iris-linear-v1" && ADDRESS.test(intent.recipient ?? "") &&
    HEX.test(intent.nonce ?? "") && HEX.test(intent.bundleHash ?? "") &&
    HEX.test(intent.evidenceDigest ?? "") && intent.networkId === null &&
    intent.genesisHash === null && intent.networkSubmitted === false &&
    intent.rewardEligible === false && intent.executionVerified === false;
}

export function validateLocalIrisRunIntent(intent) {
  if (!validIntent(intent)) throw new Error("invalid local Iris run intent");
  return intent;
}

export function signLocalIrisRunReceipt({ wallet, intent }) {
  if (!validIntent(intent) || wallet?.address !== intent.recipient ||
      addressFromPublicKey(wallet.publicKey) !== wallet.address)
    throw new Error("invalid local Iris receipt request");
  const signed = { ...intent, publicKey: wallet.publicKey };
  return { ...signed, signature: signObject(signed, wallet, DOMAIN) };
}

export function verifyLocalIrisRunReceipt(receipt, { intent, evidenceBytes } = {}) {
  if (!Buffer.isBuffer(evidenceBytes))
    throw new Error("raw local Iris evidence is required for receipt verification");
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
    throw new Error("invalid local Iris receipt");
  const { publicKey, signature, ...signed } = receipt;
  if (!validIntent(signed) || Object.keys(receipt).length !== Object.keys(signed).length + 2 ||
      typeof publicKey !== "string" || publicKey.length > 4096 ||
      typeof signature !== "string" || signature.length > 10_000 ||
      addressFromPublicKey(publicKey) !== signed.recipient ||
      !verifyObject({ ...signed, publicKey }, signature, publicKey, DOMAIN))
    throw new Error("invalid local Iris receipt signature");
  if (intent && canonicalJson(signed) !== canonicalJson(validateLocalIrisRunIntent(intent)))
    throw new Error("local Iris receipt does not match this run");
  if (signed.evidenceDigest !== irisEvidenceDigest(evidenceBytes) ||
      !evidenceMatchesBundle(evidenceBytes, signed.bundleHash))
    throw new Error("local Iris receipt evidence differs");
  return { recipient: signed.recipient, signatureValid: true, evidenceBytesBound: true,
    executionVerified: false, networkSubmitted: false, rewardEligible: false };
}
