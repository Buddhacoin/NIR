import { randomBytes, X509Certificate } from "node:crypto";
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJson, signObject, verifyObject } from "./crypto.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";
import { NirChain } from "./chain.mjs";
import { initializeBlockStore } from "./block-store.mjs";
import { compileGenesis, verifyGenesisCeremony } from "./genesis-ceremony.mjs";
import { verifyCeremonyRegistryAnchorForLatestPlan } from "./genesis-ceremony-anchor.mjs";
import { peerRegistryHash } from "./peer-registry.mjs";
import { validatorSetId } from "./validator-rotation.mjs";
import { decryptWallet } from "./vault.mjs";

const FILES = Object.freeze([
  "CEREMONY-ANCHOR.json", "CEREMONY-APPROVALS.json", "CEREMONY-PLAN.json",
  "SIGNED-RELEASE.json", "TLS-CERTIFICATE.pem", "TRANSPORT-VAULT.json",
  "VALIDATOR-ONBOARDING.json", "VALIDATOR-VAULT.json", "genesis.json",
]);
const RUNTIME_DIRECTORIES = Object.freeze([
  "block-backups", "blocks", "commits", "mempool", "prepares", "timeouts",
]);
const RUNTIME_FILES = Object.freeze(["STORE-CHECKPOINT.backup.json", "STORE-CHECKPOINT.json"]);
const OPTIONAL_RUNTIME_DIRECTORIES = new Set([
  "certificates", "handoffs", "snapshots", "topologies",
]);
const HASH = /^[0-9a-f]{64}$/;

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function securityFlags() {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY)) {
    throw new Error("validator ceremony initialization requires no-follow directory support");
  }
}

function exists(path) {
  try { lstatSync(path); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function openDirectory(path, label) {
  securityFlags();
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`${label} is unsafe`);
  const descriptor = openSync(
    path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const opened = fstatSync(descriptor);
  if (!opened.isDirectory() || !sameIdentity(before, opened)) {
    closeSync(descriptor); throw new Error(`${label} changed during open`);
  }
  return { descriptor, metadata: opened };
}

function assertDirectory(path, opened, label) {
  const linked = lstatSync(path);
  const current = fstatSync(opened.descriptor);
  if (!linked.isDirectory() || linked.isSymbolicLink() ||
      !sameIdentity(linked, opened.metadata) || !sameIdentity(current, opened.metadata)) {
    throw new Error(`${label} changed during operation`);
  }
}

function writePrivate(path, contents) {
  let descriptor;
  try {
    descriptor = openSync(
      path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, contents);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      throw new Error("validator ceremony file write is unsafe");
    }
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function certFingerprint(certificatePem) {
  let certificate;
  try { certificate = new X509Certificate(certificatePem); }
  catch { throw new Error("validator TLS certificate is invalid"); }
  return certificate.fingerprint256.replaceAll(":", "").toLowerCase();
}

function verifyPossession(wallet, payload, domain) {
  const signature = signObject(payload, wallet, domain);
  if (!verifyObject(payload, signature, wallet.publicKey, domain)) {
    throw new Error("validator local key possession proof failed");
  }
}

function validateInputs({
  anchor, envelope, genesis, plan, signedRelease, tlsCertificatePem, transportPassword,
  transportVault, trustedAddress, validatorPassword, validatorVault,
}, { retainWallets = false } = {}) {
  const releaseOptions = { signedRelease, trustedAddress };
  verifyGenesisCeremony(plan, envelope, releaseOptions);
  const compiled = compileGenesis(plan, envelope, releaseOptions);
  if (canonicalJson(genesis) !== canonicalJson(compiled.genesis)) {
    throw new Error("compiled genesis does not match the verified ceremony");
  }
  verifyCeremonyRegistryAnchorForLatestPlan(
    anchor, plan, compiled.genesisHash, releaseOptions,
  );
  let validatorWallet;
  let transportWallet;
  let retained = false;
  try {
    validatorWallet = decryptWallet(validatorVault, validatorPassword);
    transportWallet = decryptWallet(transportVault, transportPassword);
    const participant = plan.validators.find(({ address }) => address === validatorWallet.address);
    if (!participant) throw new Error("local validator vault is not a ceremony validator");
    if (participant.transport.address !== transportWallet.address ||
        participant.transport.publicKey !== transportWallet.publicKey) {
      throw new Error("local transport vault does not match the ceremony validator");
    }
    const peer = genesis.peerRegistry?.peers?.find(
      ({ validatorAddress }) => validatorAddress === participant.address,
    );
    if (!peer || peer.url !== participant.endpoint ||
        canonicalJson(peer.transport) !== canonicalJson(participant.transport) ||
        peer.tlsCertificateSha256 !== participant.tlsCertificateSha256 ||
        peerRegistryHash(genesis.peerRegistry) !== plan.peerRegistryCommitment ||
        validatorSetId(genesis.validators) !== plan.validatorSetCommitment) {
      throw new Error("genesis validator set or peer topology does not match the ceremony");
    }
    if (new URL(participant.endpoint).protocol !== "https:" ||
        !HASH.test(participant.tlsCertificateSha256 ?? "") ||
        certFingerprint(tlsCertificatePem) !== participant.tlsCertificateSha256) {
      throw new Error("local TLS certificate does not match the ceremony endpoint pin");
    }
    const possession = {
      genesisHash: compiled.genesisHash,
      planCommitment: plan.commitment,
      purpose: "validator-ceremony-local-possession",
    };
    verifyPossession(validatorWallet, possession, "VALIDATOR_CEREMONY_POSSESSION_V1");
    verifyPossession(transportWallet, possession, "TRANSPORT_CEREMONY_POSSESSION_V1");
    const result = {
      compiled,
      provenance: {
        anchorHead: anchor.payload.registryHead,
        endpoint: participant.endpoint,
        format: "nir-validator-ceremony-onboarding-v1",
        genesisHash: compiled.genesisHash,
        operatorId: participant.operatorId,
        planCommitment: plan.commitment,
        releaseManifestHash: plan.sourceRelease.manifestHash,
        tlsCertificateSha256: participant.tlsCertificateSha256,
        transportAddress: transportWallet.address,
        validatorAddress: validatorWallet.address,
      },
    };
    if (retainWallets) {
      result.validatorWallet = validatorWallet;
      result.transportWallet = transportWallet;
      retained = true;
    }
    return result;
  } finally {
    if (!retained) {
      if (validatorWallet) validatorWallet.privateKey = "";
      if (transportWallet) transportWallet.privateKey = "";
    }
  }
}

function serializedJson(value) { return Buffer.from(`${canonicalJson(value)}\n`); }

export function initializeValidatorFromCeremony(targetPath, inputs) {
  const verified = validateInputs(inputs);
  const target = resolve(targetPath);
  const parent = dirname(target);
  const parentOpened = openDirectory(parent, "validator ceremony parent");
  if (exists(target)) {
    closeSync(parentOpened.descriptor);
    throw new Error("validator ceremony target must not exist");
  }
  let generation = null;
  let generationIdentity = null;
  let activated = false;
  try {
    generation = join(parent,
      `.${basename(target)}.nir-validator-generation-${randomBytes(16).toString("hex")}`);
    mkdirSync(generation, { mode: 0o700 });
    chmodSync(generation, 0o700);
    generationIdentity = lstatSync(generation);
    const files = new Map([
      ["CEREMONY-ANCHOR.json", serializedJson(inputs.anchor)],
      ["CEREMONY-APPROVALS.json", serializedJson(inputs.envelope)],
      ["CEREMONY-PLAN.json", serializedJson(inputs.plan)],
      ["SIGNED-RELEASE.json", serializedJson(inputs.signedRelease)],
      ["TLS-CERTIFICATE.pem", Buffer.from(inputs.tlsCertificatePem)],
      ["TRANSPORT-VAULT.json", serializedJson(inputs.transportVault)],
      ["VALIDATOR-ONBOARDING.json", serializedJson(verified.provenance)],
      ["VALIDATOR-VAULT.json", serializedJson(inputs.validatorVault)],
      ["genesis.json", serializedJson(inputs.genesis)],
    ]);
    for (const name of FILES) writePrivate(join(generation, name), files.get(name));
    for (const name of ["commits", "mempool", "prepares", "timeouts"]) {
      mkdirSync(join(generation, name), { mode: 0o700 });
      chmodSync(join(generation, name), 0o700);
    }
    initializeBlockStore(generation, new NirChain(inputs.genesis));
    const generationOpened = openDirectory(generation, "validator ceremony generation");
    try {
      fsyncSync(generationOpened.descriptor);
      assertDirectory(generation, generationOpened, "validator ceremony generation");
    } finally { closeSync(generationOpened.descriptor); }
    assertDirectory(parent, parentOpened, "validator ceremony parent");
    symlinkSync(basename(generation), target, "dir");
    activated = true;
    fsyncSync(parentOpened.descriptor);
    generation = null;
    return structuredClone(verified.provenance);
  } catch (error) {
    if (activated) {
      try {
        if (readlinkSync(target) === basename(generation)) unlinkSync(target);
      } catch { /* Preserve anything which no longer exactly matches our activation. */ }
    }
    if (generation !== null && generationIdentity !== null) {
      try {
        const current = lstatSync(generation);
        if (current.isDirectory() && !current.isSymbolicLink() &&
            sameIdentity(current, generationIdentity)) {
          rmSync(generation, { recursive: true, force: true });
          fsyncSync(parentOpened.descriptor);
        }
      } catch { /* Never broaden cleanup after a failed identity check. */ }
    }
    throw error;
  } finally { closeSync(parentOpened.descriptor); }
}

function readInstalled(target, opened, name, maximum = 16 * 1024 * 1024) {
  const path = join(target, name);
  assertDirectory(target, opened, "validator ceremony generation");
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maximum ||
        (metadata.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
      throw new Error("validator ceremony file is unsafe");
    }
    const contents = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!sameIdentity(metadata, after) || metadata.size !== after.size ||
        contents.length !== metadata.size) {
      throw new Error("validator ceremony file changed while reading");
    }
    assertDirectory(target, opened, "validator ceremony generation");
    return contents;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function reverifyValidatorFromCeremony(targetPath, {
  transportPassword, trustedAddress, validatorPassword,
}) {
  const target = resolve(targetPath);
  const activation = lstatSync(target);
  if (!activation.isSymbolicLink()) throw new Error("validator ceremony target is not an activation link");
  const link = readlinkSync(target);
  if (!new RegExp(`^\\.${basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.nir-validator-generation-[0-9a-f]{32}$`)
    .test(link)) throw new Error("validator ceremony activation link is invalid");
  const generation = join(dirname(target), link);
  const opened = openDirectory(generation, "validator ceremony generation");
  try {
    const entries = readdirSync(generation).sort();
    const required = [...FILES, ...RUNTIME_DIRECTORIES, ...RUNTIME_FILES].sort();
    const foreign = entries.filter((name) =>
      !required.includes(name) && !OPTIONAL_RUNTIME_DIRECTORIES.has(name));
    if ((opened.metadata.mode & 0o777) !== 0o700 ||
        (typeof process.getuid === "function" && opened.metadata.uid !== process.getuid()) ||
        foreign.length > 0 ||
        required.some((name) => !entries.includes(name))) {
      throw new Error("validator ceremony installed file set is invalid");
    }
    for (const name of [...RUNTIME_DIRECTORIES, ...OPTIONAL_RUNTIME_DIRECTORIES]
      .filter((entry) => entries.includes(entry))) {
      const metadata = lstatSync(join(generation, name));
      if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
          (metadata.mode & 0o777) !== 0o700 ||
          (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
        throw new Error("validator ceremony runtime directory is unsafe");
      }
    }
    for (const name of RUNTIME_FILES) readInstalled(generation, opened, name);
    const parse = (name) => parseConsensusJson(
      readInstalled(generation, opened, name).toString("utf8"),
    );
    const inputs = {
      anchor: parse("CEREMONY-ANCHOR.json"),
      envelope: parse("CEREMONY-APPROVALS.json"),
      genesis: parse("genesis.json"),
      plan: parse("CEREMONY-PLAN.json"),
      signedRelease: parse("SIGNED-RELEASE.json"),
      tlsCertificatePem: readInstalled(generation, opened, "TLS-CERTIFICATE.pem"),
      transportPassword,
      transportVault: parse("TRANSPORT-VAULT.json"),
      trustedAddress,
      validatorPassword,
      validatorVault: parse("VALIDATOR-VAULT.json"),
    };
    const verified = validateInputs(inputs);
    const stored = parse("VALIDATOR-ONBOARDING.json");
    if (canonicalJson(stored) !== canonicalJson(verified.provenance)) {
      throw new Error("validator ceremony provenance does not match installed evidence");
    }
    assertDirectory(generation, opened, "validator ceremony generation");
    return { ...verified.provenance, verified: true };
  } finally { closeSync(opened.descriptor); }
}

function passwordString(buffer, label) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > 1_024 ||
      buffer.includes(0) || buffer.includes(10) || buffer.includes(13)) {
    throw new Error(`${label} password buffer is invalid`);
  }
  return buffer.toString("utf8");
}

export function loadValidatorRuntimeFromCeremony(targetPath, {
  transportPasswordBuffer, trustedAddress, validatorPasswordBuffer,
}) {
  let validatorPassword;
  let transportPassword;
  try {
    validatorPassword = passwordString(validatorPasswordBuffer, "validator vault");
    transportPassword = passwordString(transportPasswordBuffer, "transport vault");
    const target = resolve(targetPath);
    const link = readlinkSync(target);
    if (!new RegExp(`^\\.${basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.nir-validator-generation-[0-9a-f]{32}$`)
      .test(link)) throw new Error("validator ceremony activation link is invalid");
    const generation = join(dirname(target), link);
    // Reverification also rejects plaintext key files as foreign root entries.
    reverifyValidatorFromCeremony(target, {
      transportPassword, trustedAddress, validatorPassword,
    });
    const opened = openDirectory(generation, "validator ceremony generation");
    try {
      const parse = (name) => parseConsensusJson(
        readInstalled(generation, opened, name).toString("utf8"),
      );
      const result = validateInputs({
        anchor: parse("CEREMONY-ANCHOR.json"),
        envelope: parse("CEREMONY-APPROVALS.json"),
        genesis: parse("genesis.json"),
        plan: parse("CEREMONY-PLAN.json"),
        signedRelease: parse("SIGNED-RELEASE.json"),
        tlsCertificatePem: readInstalled(generation, opened, "TLS-CERTIFICATE.pem"),
        transportPassword,
        transportVault: parse("TRANSPORT-VAULT.json"),
        trustedAddress,
        validatorPassword,
        validatorVault: parse("VALIDATOR-VAULT.json"),
      }, { retainWallets: true });
      return {
        directory: generation,
        directoryIdentity: { dev: opened.metadata.dev, ino: opened.metadata.ino },
        provenance: result.provenance,
        transportWallet: result.transportWallet,
        validatorWallet: result.validatorWallet,
      };
    } finally { closeSync(opened.descriptor); }
  } finally {
    validatorPasswordBuffer?.fill(0);
    transportPasswordBuffer?.fill(0);
    validatorPassword = "";
    transportPassword = "";
  }
}
