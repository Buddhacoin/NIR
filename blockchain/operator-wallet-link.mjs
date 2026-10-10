import { addressFromPublicKey, signObject, verifyObject } from "./crypto.mjs";

const DOMAIN = "NIR_MODEL_LAB_LOCAL_WALLET_LINK_V1";
const FORMAT = "nir-model-lab-local-wallet-link-v1";
const LIFETIME_MS = 300_000;
const CHALLENGE = /^[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;

function payload({ address, publicKey, challenge, issuedAt, expiresAt }) {
  return {
    format: FORMAT, audience: "nir-model-lab-local", scope: "address-ownership-only",
    address, publicKey, challenge, issuedAt, expiresAt,
    networkId: null, genesisHash: null, permissions: [], rewardEligible: false,
  };
}

export function createOperatorWalletProof({ wallet, challenge, now = Date.now() }) {
  if (!CHALLENGE.test(challenge) || !Number.isSafeInteger(now) || now < 0 ||
      !ADDRESS.test(wallet?.address ?? "") ||
      addressFromPublicKey(wallet.publicKey) !== wallet.address) {
    throw new Error("invalid local wallet-link request");
  }
  const signed = payload({ address: wallet.address, publicKey: wallet.publicKey,
    challenge, issuedAt: now, expiresAt: now + LIFETIME_MS });
  return { ...signed, signature: signObject(signed, wallet, DOMAIN) };
}

export function verifyOperatorWalletProof(proof, { challenge, now = Date.now() }) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof) ||
      Object.keys(proof).sort().join(",") !==
      ["format", "audience", "scope", "address", "publicKey", "challenge", "issuedAt",
        "expiresAt", "networkId", "genesisHash", "permissions", "rewardEligible", "signature"].sort().join(",") ||
      !CHALLENGE.test(challenge ?? "") || proof.challenge !== challenge ||
      !ADDRESS.test(proof.address ?? "") ||
      typeof proof.publicKey !== "string" || proof.publicKey.length > 4096 ||
      addressFromPublicKey(proof.publicKey) !== proof.address ||
      proof.format !== FORMAT || proof.audience !== "nir-model-lab-local" ||
      proof.scope !== "address-ownership-only" || proof.networkId !== null ||
      proof.genesisHash !== null || proof.rewardEligible !== false ||
      !Array.isArray(proof.permissions) || proof.permissions.length !== 0 ||
      !Number.isSafeInteger(proof.issuedAt) || !Number.isSafeInteger(proof.expiresAt) ||
      !Number.isSafeInteger(now) || proof.issuedAt > now + 30_000 ||
      proof.expiresAt !== proof.issuedAt + LIFETIME_MS || now >= proof.expiresAt ||
      typeof proof.signature !== "string" || proof.signature.length > 10_000) {
    throw new Error("local wallet-link proof is invalid or expired");
  }
  const { signature, ...signed } = proof;
  if (!verifyObject(signed, signature, proof.publicKey, DOMAIN)) {
    throw new Error("local wallet-link signature is invalid");
  }
  return proof.address;
}
