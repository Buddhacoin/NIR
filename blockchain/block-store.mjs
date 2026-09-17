import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { NirChain } from "./chain.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";
import { hashObject } from "./crypto.mjs";
import { MAX_BLOCK_BYTES } from "./constants.mjs";
import { installStateSnapshot, loadInstalledStateSnapshot } from "./snapshot-store.mjs";
import { copyAccountHistoryIndex } from "./account-history-index.mjs";

const BACKUP_DIRECTORY = "block-backups";
const BLOCKS_DIRECTORY = "blocks";
const CHECKPOINT_BACKUP_FILE = "STORE-CHECKPOINT.backup.json";
const CHECKPOINT_FILE = "STORE-CHECKPOINT.json";
const FORMAT_V1 = "nir-block-store-v1";
const FORMAT = "nir-block-store-v2";
const SNAPSHOTS_DIRECTORY = "snapshots";
const PRUNE_DIRECTORY = "prune-quarantine";
const PRUNE_MANIFEST = "PRUNE-MANIFEST.json";
const PRUNE_VERIFIED = "PRUNE-VERIFIED.json";
const PRUNE_FINALIZING = "PRUNE-FINALIZING.json";
const SCRUB_INSTALLING = "SCRUB-INSTALLING.json";
const BLOCK_NAME = /^[0-9]{12}\.json$/;
const MAX_PRUNE_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_PRUNE_MARKER_BYTES = 64 * 1024;
const MAX_PRUNE_BLOCK_FILE_BYTES = MAX_BLOCK_BYTES * 4;
export const DEFAULT_MAX_PRUNED_TAIL_BLOCKS = 100_000;
export const DEFAULT_MAX_PRUNED_TAIL_BYTES = 64 * 1024 * 1024 * 1024;

export function readBlockStoreCheckpoint(directory, genesis) {
  const root = resolve(directory);
  const candidates = [CHECKPOINT_FILE, CHECKPOINT_BACKUP_FILE]
    .map((name) => readCheckpoint(join(root, name), genesis.networkId));
  const valid = candidates.filter(Boolean).sort((left, right) => right.height - left.height);
  if (valid.length === 0) throw new Error("block-store checkpoints are unavailable or corrupt");
  if (valid.length === 2 && valid[0].height === valid[1].height &&
      valid[0].checkpointHash !== valid[1].checkpointHash) {
    throw new Error("block-store checkpoints conflict at the same height");
  }
  return structuredClone(valid[0]);
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fileSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function syncDirectory(path) {
  const descriptor = openSync(path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeAtomic(path, contents, mode = 0o600) {
  const parent = dirname(path);
  const parentMetadata = lstatSync(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("block store destination directory is unsafe");
  }
  const temporary = join(parent,
    `.${randomBytes(16).toString("hex")}.${process.pid}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT |
      fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    syncDirectory(parent);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function readBoundedRegularText(path, maximumBytes, message) {
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maximumBytes) throw new Error(message);
    const contents = readFileSync(descriptor);
    if (contents.length > maximumBytes) throw new Error(message);
    return contents.toString("utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function blockName(height) {
  if (!Number.isSafeInteger(height) || height < 1) throw new Error("block height is invalid");
  return `${String(height).padStart(12, "0")}.json`;
}

function checkpointPayload(chain) {
  const retained = chain.blocks();
  const base = retained[0];
  const blocks = retained.slice(1).map((block) => {
    const contents = serialized(block);
    return { blockHash: block.hash, fileSha256: fileSha256(contents), height: block.height };
  });
  return {
    blocks,
    baseHash: base.hash,
    baseHeight: base.height,
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
  if (!value || ![FORMAT, FORMAT_V1].includes(value.format) || value.networkId !== networkId ||
      !Number.isSafeInteger(value.height) || value.height < 0 ||
      !/^[0-9a-f]{64}$/.test(value.tipHash ?? "") ||
      !Array.isArray(value.blocks)) {
    throw new Error("block-store checkpoint header is invalid");
  }
  const baseHeight = value.format === FORMAT_V1 ? 0 : value.baseHeight;
  const baseHash = value.format === FORMAT_V1 ? null : value.baseHash;
  if (!Number.isSafeInteger(baseHeight) || baseHeight < 0 || baseHeight > value.height ||
      (value.format === FORMAT && !/^[0-9a-f]{64}$/.test(baseHash ?? "")) ||
      value.blocks.length !== value.height - baseHeight) {
    throw new Error("block-store checkpoint base is invalid");
  }
  for (const [index, entry] of value.blocks.entries()) {
    if (entry?.height !== baseHeight + index + 1 || !/^[0-9a-f]{64}$/.test(entry.blockHash ?? "") ||
        !/^[0-9a-f]{64}$/.test(entry.fileSha256 ?? "")) {
      throw new Error("block-store checkpoint entries are invalid");
    }
  }
  if (value.blocks.length > 0 && value.blocks.at(-1).blockHash !== value.tipHash) {
    throw new Error("block-store checkpoint tip is inconsistent");
  }
  if (value.blocks.length === 0 && baseHash !== null && baseHash !== value.tipHash) {
    throw new Error("block-store checkpoint base tip is inconsistent");
  }
  const { checkpointHash, ...payload } = value;
  if (checkpointHash !== hashObject(payload, "BLOCK_STORE_CHECKPOINT")) {
    throw new Error("block-store checkpoint checksum mismatch");
  }
  return { ...structuredClone(value), baseHash, baseHeight };
}

function readCheckpoint(path, networkId) {
  try { return verifyCheckpoint(parseConsensusJson(readFileSync(path, "utf8")), networkId); }
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
    const block = parseConsensusJson(contents);
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

export function loadBlockStore(directory, genesis, {
  allowIntegrityInstall = false,
  handoffs = [],
  repair = true,
  trustedValidators = genesis.validators,
} = {}) {
  const root = resolve(directory);
  if (existsSync(join(root, SCRUB_INSTALLING)) && !allowIntegrityInstall) {
    throw new Error("block store has an incomplete integrity installation");
  }
  if (repair) {
    mkdirSync(join(root, BLOCKS_DIRECTORY), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, BACKUP_DIRECTORY), { recursive: true, mode: 0o700 });
  } else if (![BLOCKS_DIRECTORY, BACKUP_DIRECTORY].every((name) => {
    const path = join(root, name);
    return existsSync(path) && !lstatSync(path).isSymbolicLink() && lstatSync(path).isDirectory();
  })) {
    throw new Error("block-store journal directories are missing");
  }
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
  const trustAnchor = { expectedNetworkId: genesis.networkId, handoffs, trustedValidators };
  const installed = loadInstalledStateSnapshot(
    join(root, SNAPSHOTS_DIRECTORY), genesis, trustAnchor,
    { repair },
  );
  let chain = installed?.chain ?? new NirChain(genesis);
  const baseHeight = chain.height;
  const baseHash = chain.tipHash;
  if (checkpoint?.baseHeight > 0 && !installed) {
    throw new Error("block-store snapshot base is missing");
  }
  if (checkpoint && checkpoint.baseHeight === baseHeight && checkpoint.baseHash !== null &&
      checkpoint.baseHash !== baseHash) {
    throw new Error("block-store checkpoint snapshot base is invalid");
  }
  if (checkpoint?.height === 0 && baseHeight === 0 && checkpoint.tipHash !== chain.tipHash) {
    throw new Error("block-store checkpoint genesis tip is invalid");
  }
  let recoveredCopies = 0;
  for (let height = baseHeight + 1; height <= lastHeight; height += 1) {
    const name = blockName(height);
    const checkpointMatchesBase = checkpoint?.baseHeight === baseHeight &&
      (checkpoint.baseHash === null || checkpoint.baseHash === baseHash);
    const expected = checkpointMatchesBase && height <= checkpoint.height
      ? checkpoint.blocks[height - checkpoint.baseHeight - 1] : null;
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
      if (repair) writeAtomic(join(primaryDirectory, name), canonicalContents);
      recoveredCopies += 1;
    }
    if (!backup || backup.contents !== canonicalContents) {
      if (repair) writeAtomic(join(backupDirectory, name), canonicalContents);
      recoveredCopies += 1;
    }
  }
  if (checkpoint && checkpoint.height > chain.height) {
    throw new Error("block-store checkpoint is ahead of the recoverable journal");
  }
  if (repair) writeCheckpoint(root, chain);
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

export function installBlockStoreSnapshot(directory, genesis, snapshot, {
  handoffs = [],
  trustedValidators = genesis.validators,
} = {}) {
  const root = resolve(directory);
  const trustAnchor = { expectedNetworkId: genesis.networkId, handoffs, trustedValidators };
  const installed = installStateSnapshot(
    join(root, SNAPSHOTS_DIRECTORY), genesis, snapshot, trustAnchor,
  );
  const loaded = loadBlockStore(root, genesis, { handoffs, trustedValidators });
  if (loaded.chain.height < installed.height) {
    throw new Error("installed snapshot did not become the block-store base");
  }
  return { ...installed, chain: loaded.chain, recoveredCopies: loaded.recoveredCopies };
}

function pruningDirectories(root) {
  const path = join(root, PRUNE_DIRECTORY);
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(path, entry.name));
}

function readPruneManifest(path) {
  try {
    const manifestPath = join(path, PRUNE_MANIFEST);
    const value = parseConsensusJson(readBoundedRegularText(
      manifestPath, MAX_PRUNE_MANIFEST_BYTES, "block pruning manifest is invalid",
    ));
    if (!["nir-prune-quarantine-v1", "nir-prune-quarantine-v2"].includes(value?.format) ||
        typeof value.networkId !== "string" || value.networkId.length < 1 ||
        !Number.isSafeInteger(value.baseHeight) || value.baseHeight < 1 ||
        !/^[0-9a-f]{64}$/.test(value.baseHash ?? "") ||
        !Array.isArray(value.files) || value.files.some((file) =>
          ![BLOCKS_DIRECTORY, BACKUP_DIRECTORY].includes(file?.folder) ||
          !BLOCK_NAME.test(file?.name) || (value.format === "nir-prune-quarantine-v2" &&
            (!Number.isSafeInteger(file.bytes) || file.bytes < 1 ||
             !/^[0-9a-f]{64}$/.test(file.fileSha256 ?? ""))))) throw new Error("invalid");
    const keys = value.files.map((file) => `${file.folder}/${file.name}`);
    if (new Set(keys).size !== keys.length ||
        keys.some((key, index) => index > 0 && key <= keys[index - 1])) throw new Error("invalid");
    return value;
  } catch {
    throw new Error("block pruning manifest is invalid");
  }
}

function fileDetails(path) {
  const contents = readBoundedRegularText(
    path, MAX_PRUNE_BLOCK_FILE_BYTES, "block pruning file is invalid",
  );
  return { bytes: Buffer.byteLength(contents), contents, fileSha256: fileSha256(contents) };
}

function assertManifestFile(path, file) {
  const actual = fileDetails(path);
  if (file.fileSha256 && (actual.fileSha256 !== file.fileSha256 || actual.bytes !== file.bytes)) {
    throw new Error("block pruning file checksum mismatch");
  }
  return actual;
}

function pruneManifestHash(manifest) {
  return hashObject(manifest, "BLOCK_PRUNE_MANIFEST");
}

function completeStagedMoves(root, quarantine, manifest) {
  for (const file of manifest.files) {
    const source = join(root, file.folder, file.name);
    const target = join(quarantine, file.folder, file.name);
    const sourceExists = existsSync(source);
    const targetExists = existsSync(target);
    if (sourceExists && targetExists) {
      const sourceFile = assertManifestFile(source, file);
      const targetFile = assertManifestFile(target, file);
      if (sourceFile.contents !== targetFile.contents) {
        throw new Error("block pruning copies conflict");
      }
      rmSync(source);
    } else if (sourceExists) {
      assertManifestFile(source, file);
      renameSync(source, target);
    } else if (targetExists) {
      assertManifestFile(target, file);
    } else {
      throw new Error("a staged pruning block is missing");
    }
  }
  for (const folder of [BLOCKS_DIRECTORY, BACKUP_DIRECTORY]) {
    syncDirectory(join(root, folder));
    syncDirectory(join(quarantine, folder));
  }
}

function pruningPolicy(options) {
  const policy = options.pruningPolicy ?? {};
  const normalized = {
    maximumTailBlocks: policy.maximumTailBlocks ?? DEFAULT_MAX_PRUNED_TAIL_BLOCKS,
    maximumTailBytes: policy.maximumTailBytes ?? DEFAULT_MAX_PRUNED_TAIL_BYTES,
    minimumPrunableBlocks: policy.minimumPrunableBlocks ?? 1,
    minimumPrunableBytes: policy.minimumPrunableBytes ?? 1,
  };
  if (![normalized.maximumTailBlocks, normalized.maximumTailBytes].every((value) =>
    Number.isSafeInteger(value) && value >= 0) ||
      ![normalized.minimumPrunableBlocks, normalized.minimumPrunableBytes].every((value) =>
        Number.isSafeInteger(value) && value >= 1)) {
    throw new Error("block pruning policy is invalid");
  }
  return normalized;
}

function createBlockPruningPlan(directory, genesis, options = {}) {
  const root = resolve(directory);
  if (pruningDirectories(root).length > 0) {
    throw new Error("staged block pruning must be verified or finalized first");
  }
  const loaded = loadBlockStore(root, genesis, options);
  const base = loaded.chain.blocks()[0];
  if (base.height < 1) throw new Error("block pruning requires an installed state snapshot");
  const files = [];
  let journalBytes = 0;
  let prunableBytes = 0;
  const prunableHeights = new Set();
  for (const folder of [BLOCKS_DIRECTORY, BACKUP_DIRECTORY]) {
    const path = join(root, folder);
    for (const height of heightsIn(path)) {
      const name = blockName(height);
      const details = fileDetails(join(path, name));
      journalBytes += details.bytes;
      if (height <= base.height) {
        files.push({
          bytes: details.bytes, fileSha256: details.fileSha256, folder, name,
        });
        prunableBytes += details.bytes;
        prunableHeights.add(height);
      }
    }
  }
  files.sort((left, right) =>
    `${left.folder}/${left.name}`.localeCompare(`${right.folder}/${right.name}`));
  const snapshotBytes = ["STATE-SNAPSHOT.json", "STATE-SNAPSHOT.backup.json"]
    .map((name) => statSync(join(root, SNAPSHOTS_DIRECTORY, name)).size)
    .reduce((sum, bytes) => sum + bytes, 0);
  const policy = pruningPolicy(options);
  const tailBlocks = loaded.chain.height - base.height;
  const tailBytes = journalBytes - prunableBytes;
  const reasons = [];
  if (prunableHeights.size < policy.minimumPrunableBlocks) {
    reasons.push("prunable block count is below policy minimum");
  }
  if (prunableBytes < policy.minimumPrunableBytes) {
    reasons.push("prunable bytes are below policy minimum");
  }
  if (tailBlocks > policy.maximumTailBlocks) {
    reasons.push("snapshot tail block count exceeds policy maximum; install a newer snapshot");
  }
  if (tailBytes > policy.maximumTailBytes) {
    reasons.push("snapshot tail bytes exceed policy maximum; install a newer snapshot");
  }
  return {
    baseHash: base.hash,
    baseHeight: base.height,
    eligible: reasons.length === 0,
    files,
    journalBytes,
    policy,
    projectedLiveBytes: snapshotBytes + tailBytes,
    prunableBlocks: prunableHeights.size,
    prunableBytes,
    reasons,
    snapshotBytes,
    tailBlocks,
    tailBytes,
    tipHeight: loaded.chain.height,
  };
}

export function planBlockPruning(directory, genesis, options = {}) {
  const { files: _files, ...plan } = createBlockPruningPlan(directory, genesis, options);
  return plan;
}

export function stageBlockPruning(directory, genesis, options = {}) {
  const root = resolve(directory);
  const plan = createBlockPruningPlan(root, genesis, options);
  if (!plan.eligible) throw new Error(`block pruning policy rejected plan: ${plan.reasons.join("; ")}`);
  const quarantine = join(root, PRUNE_DIRECTORY,
    `${String(plan.baseHeight).padStart(12, "0")}-${plan.baseHash}`);
  if (existsSync(quarantine)) throw new Error("block pruning is already staged for this snapshot");
  for (const folder of [BLOCKS_DIRECTORY, BACKUP_DIRECTORY]) {
    mkdirSync(join(quarantine, folder), { recursive: true, mode: 0o700 });
  }
  const manifest = {
    baseHash: plan.baseHash,
    baseHeight: plan.baseHeight,
    files: plan.files,
    format: "nir-prune-quarantine-v2",
    networkId: genesis.networkId,
  };
  writeAtomic(join(quarantine, PRUNE_MANIFEST), serialized(manifest));
  completeStagedMoves(root, quarantine, manifest);
  return {
    baseHash: plan.baseHash, baseHeight: plan.baseHeight, movedFiles: plan.files.length,
    prunableBytes: plan.prunableBytes, projectedLiveBytes: plan.projectedLiveBytes, quarantine,
  };
}

export function verifyStagedBlockPruning(directory, genesis, options = {}) {
  const root = resolve(directory);
  const quarantines = pruningDirectories(root);
  if (quarantines.length === 0) throw new Error("no staged block pruning exists");
  for (const quarantine of quarantines) {
    const manifest = readPruneManifest(quarantine);
    completeStagedMoves(root, quarantine, manifest);
  }
  const loaded = loadBlockStore(root, genesis, options);
  const base = loaded.chain.blocks()[0];
  for (const quarantine of quarantines) {
    const manifest = readPruneManifest(quarantine);
    if (manifest.networkId !== genesis.networkId || manifest.baseHeight !== base.height ||
        manifest.baseHash !== base.hash) {
      throw new Error("staged block pruning does not match the verified snapshot base");
    }
    writeAtomic(join(quarantine, PRUNE_VERIFIED), serialized({
      baseHash: base.hash,
      baseHeight: base.height,
      checkpointHash: loaded.checkpoint.checkpointHash,
      format: "nir-prune-verification-v1",
      manifestHash: pruneManifestHash(manifest),
      networkId: genesis.networkId,
    }));
  }
  return { baseHeight: base.height, quarantines: quarantines.length, verifiedHeight: loaded.chain.height };
}

export function finalizeBlockPruning(directory, genesis, options = {}) {
  const root = resolve(directory);
  const quarantines = pruningDirectories(root);
  if (quarantines.length === 0) throw new Error("no staged block pruning exists");
  const loaded = loadBlockStore(root, genesis, options);
  const base = loaded.chain.blocks()[0];
  let deletedFiles = 0;
  let plannedFiles = 0;
  for (const quarantine of quarantines) {
    const manifest = readPruneManifest(quarantine);
    plannedFiles += manifest.files.length;
    let verification;
    try {
      verification = parseConsensusJson(readBoundedRegularText(
        join(quarantine, PRUNE_VERIFIED), MAX_PRUNE_MARKER_BYTES,
        "block pruning verification is invalid",
      ));
    }
    catch { throw new Error("block pruning has not passed restart verification"); }
    if (verification?.format !== "nir-prune-verification-v1" ||
        verification.networkId !== genesis.networkId ||
        verification.baseHeight !== manifest.baseHeight || verification.baseHash !== manifest.baseHash ||
        verification.checkpointHash !== loaded.checkpoint.checkpointHash ||
        verification.manifestHash !== pruneManifestHash(manifest) ||
        base.height !== manifest.baseHeight || base.hash !== manifest.baseHash) {
      throw new Error("block pruning verification is stale or invalid");
    }
    const finalizingPath = join(quarantine, PRUNE_FINALIZING);
    let finalizing = null;
    if (existsSync(finalizingPath)) {
      try {
        finalizing = parseConsensusJson(readBoundedRegularText(
          finalizingPath, MAX_PRUNE_MARKER_BYTES,
          "block pruning finalization marker is invalid",
        ));
      } catch { /* fail below */ }
      if (finalizing?.format !== "nir-prune-finalizing-v1" ||
          finalizing.manifestHash !== verification.manifestHash ||
          finalizing.checkpointHash !== verification.checkpointHash) {
        throw new Error("block pruning finalization marker is invalid");
      }
    } else {
      for (const file of manifest.files) {
        assertManifestFile(join(quarantine, file.folder, file.name), file);
      }
      writeAtomic(finalizingPath, serialized({
        checkpointHash: verification.checkpointHash,
        format: "nir-prune-finalizing-v1",
        manifestHash: verification.manifestHash,
      }));
    }
    for (const file of manifest.files) {
      const target = join(quarantine, file.folder, file.name);
      if (!existsSync(target)) continue;
      assertManifestFile(target, file);
      rmSync(target);
      deletedFiles += 1;
    }
    for (const folder of [BLOCKS_DIRECTORY, BACKUP_DIRECTORY]) {
      syncDirectory(join(quarantine, folder));
    }
    rmSync(quarantine, { recursive: true });
  }
  syncDirectory(join(root, PRUNE_DIRECTORY));
  return { baseHeight: base.height, deletedFiles, plannedFiles, verifiedHeight: loaded.chain.height };
}

export function exportBlockStoreBackup(directory, destination, genesis, options = {}) {
  const source = loadBlockStore(directory, genesis, options);
  const target = resolve(destination);
  mkdirSync(target, { mode: 0o700 });
  writeAtomic(join(target, "genesis.json"), serialized(genesis), 0o644);
  let backupChain = new NirChain(genesis);
  initializeBlockStore(target, backupChain);
  if (source.chain.blocks()[0].height > 0) {
    const installed = loadInstalledStateSnapshot(
      join(resolve(directory), SNAPSHOTS_DIRECTORY), genesis,
      { expectedNetworkId: genesis.networkId, handoffs: options.handoffs ?? [],
        trustedValidators: options.trustedValidators ?? genesis.validators },
    );
    if (!installed) throw new Error("pruned block-store backup requires its installed snapshot");
    backupChain = installBlockStoreSnapshot(target, genesis, installed.snapshot, options).chain;
  }
  for (const block of source.chain.blocks().slice(1)) {
    backupChain.appendBlock(block);
    persistBlock(target, block, backupChain);
  }
  copyAccountHistoryIndex(directory, target, backupChain);
  return {
    directory: target,
    height: backupChain.height,
    networkId: backupChain.networkId,
    privateKeysIncluded: false,
    tipHash: backupChain.tipHash,
  };
}
