import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

import { SIGNATURE_ALGORITHM } from "./constants.mjs";

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function hashObject(value) {
  return createHash("sha3-256").update(canonicalJson(value)).digest("hex");
}

export function addressFromPublicKey(publicKeyBase64) {
  const digest = createHash("sha3-256")
    .update(Buffer.from(publicKeyBase64, "base64"))
    .digest("hex");
  return `nir1${digest}`;
}

export function generateWallet() {
  const { publicKey, privateKey } = generateKeyPairSync(SIGNATURE_ALGORITHM);
  const publicKeyBase64 = publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const privateKeyBase64 = privateKey
    .export({ type: "pkcs8", format: "der" })
    .toString("base64");
  return {
    address: addressFromPublicKey(publicKeyBase64),
    algorithm: SIGNATURE_ALGORITHM,
    publicKey: publicKeyBase64,
    privateKey: privateKeyBase64,
  };
}

export function signObject(value, wallet) {
  if (wallet.algorithm !== SIGNATURE_ALGORITHM) {
    throw new Error("unsupported signature algorithm");
  }
  const key = createPrivateKey({
    key: Buffer.from(wallet.privateKey, "base64"),
    type: "pkcs8",
    format: "der",
  });
  return sign(null, Buffer.from(canonicalJson(value)), key).toString("base64");
}

export function verifyObject(value, signatureBase64, publicKeyBase64) {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      type: "spki",
      format: "der",
    });
    return verify(
      null,
      Buffer.from(canonicalJson(value)),
      key,
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}

export function publicWallet(wallet) {
  return {
    address: wallet.address,
    algorithm: wallet.algorithm,
    publicKey: wallet.publicKey,
  };
}
