import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const FORMAT = "nir-wallet-trust-checkpoint-v1";
const HASH = /^[0-9a-f]{64}$/;
const MAX_BYTES = 16 * 1024;

function validate(checkpoint, expectedNetworkId) {
  if (!checkpoint || checkpoint.format !== FORMAT ||
      checkpoint.networkId !== expectedNetworkId ||
      !Number.isSafeInteger(checkpoint.height) || checkpoint.height < 0 ||
      !HASH.test(checkpoint.tipHash ?? "") || !HASH.test(checkpoint.stateRoot ?? "") ||
      !HASH.test(checkpoint.validatorSetId ?? "") ||
      (checkpoint.lastHandoffHash !== null && !HASH.test(checkpoint.lastHandoffHash ?? "")) ||
      !Number.isSafeInteger(checkpoint.lastHandoffHeight) || checkpoint.lastHandoffHeight < 0 ||
      (checkpoint.lastHandoffHash === null) !== (checkpoint.lastHandoffHeight === 0)) {
    throw new Error("wallet trust checkpoint is invalid");
  }
  return structuredClone(checkpoint);
}

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export function loadWalletTrustCheckpoint(path, expectedNetworkId) {
  const target = resolve(path);
  let metadata;
  try { metadata = lstatSync(target); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || statSync(target).size > MAX_BYTES) {
    throw new Error("wallet trust checkpoint file is unsafe");
  }
  try {
    return validate(JSON.parse(readFileSync(target, "utf8")), expectedNetworkId);
  } catch (error) {
    if (error.message.includes("checkpoint")) throw error;
    throw new Error("wallet trust checkpoint is invalid");
  }
}

export function saveWalletTrustCheckpoint(path, statement, lastHandoff = null) {
  const target = resolve(path);
  const checkpoint = validate({
    format: FORMAT,
    height: statement.height,
    lastHandoffHash: lastHandoff?.handoffHash ?? null,
    lastHandoffHeight: lastHandoff?.activationHeight ?? 0,
    networkId: statement.networkId,
    stateRoot: statement.stateRoot,
    tipHash: statement.tipHash,
    validatorSetId: statement.validatorSetId,
  }, statement.networkId);
  const contents = `${JSON.stringify(checkpoint, null, 2)}\n`;
  const temporary = `${target}.${process.pid}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    syncDirectory(dirname(target));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
  return checkpoint;
}

export function enforceWalletTrustCheckpoint(checkpoint, statement) {
  if (!checkpoint) return;
  if (statement.height < checkpoint.height ||
      (statement.height === checkpoint.height &&
       (statement.tipHash !== checkpoint.tipHash || statement.stateRoot !== checkpoint.stateRoot ||
        statement.validatorSetId !== checkpoint.validatorSetId))) {
    throw new Error("account proof would roll back the wallet trust checkpoint");
  }
}

export function requireCheckpointHandoff(checkpoint, handoffs) {
  if (!checkpoint?.lastHandoffHash) return;
  const known = handoffs.find(({ handoffHash, activationHeight }) =>
    handoffHash === checkpoint.lastHandoffHash &&
    activationHeight === checkpoint.lastHandoffHeight);
  if (!known) throw new Error("validator handoff history rolls back the wallet trust checkpoint");
}
