import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { NirChain } from "./chain.mjs";
import { hashObject } from "./crypto.mjs";

const BACKUP_DIRECTORY = "block-backups";
const BLOCKS_DIRECTORY = "blocks";
const CHECKPOINT_BACKUP_FILE = "STORE-CHECKPOINT.backup.json";
const CHECKPOINT_FILE = "STORE-CHECKPOINT.json";
const FORMAT = "nir-block-store-v1";
const BLOCK_NAME = /^[0-9]{12}\.json$/;

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fileSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeAtomic(path, contents, mode = 0o600) {
  const temporary = `${path}.${process.pid}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "w", mode);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, mode);
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function blockName(height) {
  if (!Number.isSafeInteger(height) || height < 1) throw new Error("block height is invalid");
  return `${String(height).padStart(12, "0")}.json`;
}

function checkpointPayload(chain) {
  const blocks = chain.blocks().slice(1).map((block) => {
    const contents = serialized(block);
    return { blockHash: block.hash, fileSha256: fileSha256(contents), height: block.height };
  });
  return {
    blocks,
    format: FORMAT,
    height: chain.height,
    networkId: chain.networkId,
    tipHash: chain.tipHash,
  };
}

function createCheckpoint(chain) {
  const payload = checkpointPayload(chain);
  return { ...payload, checkpointHash: hashObject(payload, "BLOCK_STORE_CHECKPOINT") };
}

function verifyCheckpoint(value, networkId) {
  if (!value || value.format !== FORMAT || value.networkId !== networkId ||
      !Number.isSafeInteger(value.height) || value.height < 0 ||
      !/^[0-9a-f]{64}$/.test(value.tipHash ?? "") ||
      !Array.isArray(value.blocks) || value.blocks.length !== value.height) {
    throw new Error("block-store checkpoint header is invalid");
  }
  for (const [index, entry] of value.blocks.entries()) {
    if (entry?.height !== index + 1 || !/^[0-9a-f]{64}$/.test(entry.blockHash ?? "") ||
        !/^[0-9a-f]{64}$/.test(entry.fileSha256 ?? "")) {
      throw new Error("block-store checkpoint entries are invalid");
    }
  }
  if (value.height > 0 && value.blocks.at(-1).blockHash !== value.tipHash) {
    throw new Error("block-store checkpoint tip is inconsistent");
  }
  const { checkpointHash, ...payload } = value;
  if (checkpointHash !== hashObject(payload, "BLOCK_STORE_CHECKPOINT")) {
    throw new Error("block-store checkpoint checksum mismatch");
  }
  return structuredClone(value);
}

function readCheckpoint(path, networkId) {
  try { return verifyCheckpoint(JSON.parse(readFileSync(path, "utf8")), networkId); }
  catch { return null; }
}

function writeCheckpoint(root, chain) {
  const contents = serialized(createCheckpoint(chain));
  writeAtomic(join(root, CHECKPOINT_BACKUP_FILE), contents);
  writeAtomic(join(root, CHECKPOINT_FILE), contents);
}

function heightsIn(path) {
  return readdirSync(path).filter((name) => BLOCK_NAME.test(name))
    .map((name) => Number(name.slice(0, 12)));
}

function readCandidate(path, expected) {
  try {
    const contents = readFileSync(path, "utf8");
    const block = JSON.parse(contents);
    if (expected && (fileSha256(contents) !== expected.fileSha256 ||
        block.hash !== expected.blockHash)) return null;
    return { block, contents };
  } catch {
    return null;
  }
}

export function initializeBlockStore(directory, chain) {
  const root = resolve(directory);
  mkdirSync(join(root, BLOCKS_DIRECTORY), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, BACKUP_DIRECTORY), { recursive: true, mode: 0o700 });
  writeCheckpoint(root, chain);
}

export function loadBlockStore(directory, genesis) {
  const root = resolve(directory);
  mkdirSync(join(root, BLOCKS_DIRECTORY), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, BACKUP_DIRECTORY), { recursive: true, mode: 0o700 });
  const checkpointPaths = [
    join(root, CHECKPOINT_FILE),
    join(root, CHECKPOINT_BACKUP_FILE),
  ];
  const checkpoints = [
    readCheckpoint(checkpointPaths[0], genesis.networkId),
    readCheckpoint(checkpointPaths[1], genesis.networkId),
  ].filter(Boolean).sort((left, right) => right.height - left.height);
  if (checkpoints.length === 0 && checkpointPaths.some(existsSync)) {
    throw new Error("all existing block-store checkpoints are corrupted");
  }
  if (checkpoints.length === 2 && checkpoints[0].height === checkpoints[1].height &&
      checkpoints[0].checkpointHash !== checkpoints[1].checkpointHash) {
    throw new Error("block-store checkpoints conflict at the same height");
  }
  const checkpoint = checkpoints[0] ?? null;
  const primaryDirectory = join(root, BLOCKS_DIRECTORY);
  const backupDirectory = join(root, BACKUP_DIRECTORY);
  const heights = [...heightsIn(primaryDirectory), ...heightsIn(backupDirectory)];
  const lastHeight = heights.reduce(
    (maximum, height) => Math.max(maximum, height), checkpoint?.height ?? 0,
  );
  let chain = new NirChain(genesis);
  if (checkpoint?.height === 0 && checkpoint.tipHash !== chain.tipHash) {
    throw new Error("block-store checkpoint genesis tip is invalid");
  }
  let recoveredCopies = 0;
  for (let height = 1; height <= lastHeight; height += 1) {
    const name = blockName(height);
    const expected = height <= (checkpoint?.height ?? 0) ? checkpoint.blocks[height - 1] : null;
    const primary = readCandidate(join(primaryDirectory, name), expected);
    const backup = readCandidate(join(backupDirectory, name), expected);
    const candidates = [primary, backup].filter(Boolean);
    if (candidates.length === 0) throw new Error(`block ${height} is missing or corrupted in both copies`);
    let accepted = null;
    let nextChain = null;
    for (const candidate of candidates) {
      try {
        const trial = chain.fork();
        trial.appendBlock(candidate.block);
        accepted = candidate;
        nextChain = trial;
        break;
      } catch {
        // Try the redundant copy; both still undergo full consensus replay.
      }
    }
    if (!accepted) throw new Error(`block ${height} failed verified replay in both copies`);
    chain = nextChain;
    if (checkpoint?.height === height && checkpoint.tipHash !== chain.tipHash) {
      throw new Error("block-store checkpoint tip does not match verified replay");
    }
    const canonicalContents = serialized(accepted.block);
    if (!primary || primary.contents !== canonicalContents) {
      writeAtomic(join(primaryDirectory, name), canonicalContents);
      recoveredCopies += 1;
    }
    if (!backup || backup.contents !== canonicalContents) {
      writeAtomic(join(backupDirectory, name), canonicalContents);
      recoveredCopies += 1;
    }
  }
  if (checkpoint && checkpoint.height > chain.height) {
    throw new Error("block-store checkpoint is ahead of the recoverable journal");
  }
  writeCheckpoint(root, chain);
  return { chain, checkpoint: createCheckpoint(chain), recoveredCopies };
}

export function persistBlock(directory, block, verifiedChain) {
  if (verifiedChain.height !== block.height || verifiedChain.tipHash !== block.hash) {
    throw new Error("block must be verified before durable persistence");
  }
  const root = resolve(directory);
  const contents = serialized(block);
  const name = blockName(block.height);
  for (const folder of [BACKUP_DIRECTORY, BLOCKS_DIRECTORY]) {
    const path = join(root, folder, name);
    if (existsSync(path)) {
      const existing = readCandidate(path, null);
      if (!existing || existing.block.hash !== block.hash) {
        throw new Error("durable block conflicts with an existing journal entry");
      }
      if (existing.contents !== contents) writeAtomic(path, contents);
    } else {
      writeAtomic(path, contents);
    }
  }
  writeCheckpoint(root, verifiedChain);
}

export function exportBlockStoreBackup(directory, destination, genesis) {
  const source = loadBlockStore(directory, genesis);
  const target = resolve(destination);
  mkdirSync(target, { mode: 0o700 });
  writeAtomic(join(target, "genesis.json"), serialized(genesis), 0o644);
  const backupChain = new NirChain(genesis);
  initializeBlockStore(target, backupChain);
  for (const block of source.chain.blocks().slice(1)) {
    backupChain.appendBlock(block);
    persistBlock(target, block, backupChain);
  }
  return {
    directory: target,
    height: backupChain.height,
    networkId: backupChain.networkId,
    privateKeysIncluded: false,
    tipHash: backupChain.tipHash,
  };
}
