import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

import { canonicalJson, hashObject } from "./crypto.mjs";
import { multisigAddress } from "./chain.mjs";
import { signObject, verifyObject } from "./crypto.mjs";

const KDF = Object.freeze({ name: "scrypt", N: 32768, r: 8, p: 1 });

function vaultMetadata(wallet, label) {
  return {
    address: wallet.address,
    algorithm: wallet.algorithm,
    format: "nir-encrypted-vault",
    label,
    publicKey: wallet.publicKey,
    version: 1,
  };
}

export function encryptWallet(wallet, password, { label = "NIR vault" } = {}) {
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("vault password must contain at least 12 characters");
  }
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });
  const metadata = vaultMetadata(wallet, label);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(canonicalJson(metadata)));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(wallet.privateKey, "utf8")),
    cipher.final(),
  ]);
  return {
    ...metadata,
    cipher: {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      name: "aes-256-gcm",
      tag: cipher.getAuthTag().toString("base64"),
    },
    kdf: { ...KDF, salt: salt.toString("base64") },
  };
}

export function decryptWallet(vault, password) {
  try {
    if (
      vault?.format !== "nir-encrypted-vault" || vault.version !== 1 ||
      vault.kdf?.name !== "scrypt" || vault.cipher?.name !== "aes-256-gcm" ||
      vault.kdf.N !== KDF.N || vault.kdf.r !== KDF.r || vault.kdf.p !== KDF.p
    ) throw new Error("unsupported vault format");
    const metadata = vaultMetadata(vault, vault.label);
    const key = scryptSync(password, Buffer.from(vault.kdf.salt, "base64"), 32, {
      N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024,
    });
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(vault.cipher.iv, "base64"));
    decipher.setAAD(Buffer.from(canonicalJson(metadata)));
    decipher.setAuthTag(Buffer.from(vault.cipher.tag, "base64"));
    const privateKey = Buffer.concat([
      decipher.update(Buffer.from(vault.cipher.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const wallet = {
      address: vault.address,
      algorithm: vault.algorithm,
      privateKey,
      publicKey: vault.publicKey,
    };
    const challenge = { address: wallet.address, purpose: "vault-key-check" };
    const signature = signObject(challenge, wallet, "VAULT_CHECK");
    if (!verifyObject(challenge, signature, wallet.publicKey, "VAULT_CHECK")) {
      throw new Error("vault key pair does not match");
    }
    return wallet;
  } catch {
    throw new Error("vault password, contents, or integrity check is invalid");
  }
}

export function createMultisigRecoveryManifest({ vaults, threshold, label = "NIR recovery plan" }) {
  if (!Array.isArray(vaults) || vaults.length < 2 || new Set(vaults.map(({ address }) => address)).size !== vaults.length) {
    throw new Error("recovery vaults must be distinct");
  }
  const memberPublicKeys = vaults.map(({ publicKey }) => publicKey);
  return {
    address: multisigAddress(memberPublicKeys, threshold),
    algorithm: "ml-dsa-65-multisig",
    label,
    members: vaults.map((vault) => ({
      address: vault.address,
      vaultHash: hashObject(vault, "ENCRYPTED_VAULT_BACKUP"),
    })).sort((a, b) => a.address.localeCompare(b.address)),
    threshold,
    version: 1,
  };
}
