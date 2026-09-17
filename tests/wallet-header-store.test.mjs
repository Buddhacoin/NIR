import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { blockHeaderHash } from "../blockchain/chain.mjs";
import { PROTOCOL_VERSION } from "../blockchain/constants.mjs";
import {
  appendWalletHeaders,
  loadWalletHeaderStore,
  walletHeaderAt,
} from "../blockchain/wallet-header-store.mjs";

const hash = (character) => character.repeat(64);

function entry(height, previousHash) {
  const header = {
    accountStateRoot: hash("a"),
    bodyHash: hash("b"),
    capabilityMemoryRoot: hash("c"),
    format: "nir-finality-header-v1",
    height,
    networkId: "nir-header-store-test",
    peerRegistryHash: hash("d"),
    previousHash,
    protocolVersion: PROTOCOL_VERSION,
    stateRoot: hash("e"),
    timestamp: height,
    transactionCount: 0,
    transactionsRoot: hash("f"),
  };
  return { hash: blockHeaderHash(header), header };
}

test("wallet finality headers persist as a checkpoint-anchored continuous chain", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-headers-"));
  const path = join(directory, "headers.json");
  const genesisCheckpoint = {
    accountStateRoot: hash("1"), height: 0, stateRoot: hash("2"), tipHash: hash("3"),
  };
  const options = {
    checkpoint: null, genesisCheckpoint, networkId: "nir-header-store-test",
  };
  try {
    let store = loadWalletHeaderStore(path, options);
    const first = entry(1, genesisCheckpoint.tipHash);
    const second = entry(2, first.hash);
    store = appendWalletHeaders(path, store, [first, second], options);
    const checkpoint = {
      accountStateRoot: second.header.accountStateRoot,
      height: 2,
      stateRoot: second.header.stateRoot,
      tipHash: second.hash,
    };
    const reloaded = loadWalletHeaderStore(path, { ...options, checkpoint });
    assert.deepEqual(walletHeaderAt(reloaded, 2), second);
    const third = entry(3, second.hash);
    const withUncheckpointedTail = appendWalletHeaders(
      path, reloaded, [third], { ...options, checkpoint },
    );
    assert.equal(withUncheckpointedTail.headers.length, 3);
    const safelyReloaded = loadWalletHeaderStore(path, { ...options, checkpoint });
    assert.equal(safelyReloaded.headers.length, 2);
    assert.equal(walletHeaderAt(safelyReloaded, 3), null);
    const damaged = JSON.parse(readFileSync(path, "utf8"));
    damaged.headers[0].header.bodyHash = hash("9");
    writeFileSync(path, JSON.stringify(damaged));
    assert.throws(() => loadWalletHeaderStore(path, { ...options, checkpoint }), /invalid/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet header store fails closed on missing checkpoint history and symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-headers-unsafe-"));
  const path = join(directory, "headers.json");
  const genesisCheckpoint = {
    accountStateRoot: hash("1"), height: 0, stateRoot: hash("2"), tipHash: hash("3"),
  };
  const options = {
    checkpoint: { ...genesisCheckpoint, height: 1, tipHash: hash("4") },
    genesisCheckpoint,
    networkId: "nir-header-store-test",
  };
  try {
    assert.throws(() => loadWalletHeaderStore(path, options), /missing behind/);
    const target = join(directory, "target.json");
    writeFileSync(target, "{}");
    symlinkSync(target, path);
    assert.throws(() => loadWalletHeaderStore(path, options), /unsafe/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
