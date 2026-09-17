import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountHistoryIndex } from "../blockchain/account-history-index.mjs";
import {
  createSignedHistoryArchive,
  restoreHistoryArchive,
  selectHistoryArchiveCandidates,
  verifySignedHistoryArchive,
} from "../blockchain/archive-sync.mjs";
import { loadBlockStore } from "../blockchain/block-store.mjs";
import { createTransfer } from "../blockchain/chain.mjs";
import { ATOMIC_UNITS } from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { initializeDevnet, PersistentDevNode } from "../blockchain/node-store.mjs";
import { verifyTransactionProof } from "../blockchain/transaction-tree.mjs";

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), "nir-archive-sync-test-"));
  const directory = join(temporary, "node");
  initializeDevnet(directory);
  const sender = generateWallet();
  const recipient = generateWallet();
  const node = new PersistentDevNode(directory);
  node.faucet(sender.address);
  node.submitTransaction(createTransfer({
    amount: ATOMIC_UNITS.toString(),
    networkId: node.networkId,
    nonce: 0,
    recipient: recipient.address,
    wallet: sender,
  }));
  const genesis = JSON.parse(readFileSync(join(directory, "genesis.json"), "utf8"));
  const { chain } = loadBlockStore(directory, genesis);
  return { chain, directory, recipient, temporary };
}

test("independent operators agree on archive contents across different chunk layouts", () => {
  const { chain, directory, recipient, temporary } = fixture();
  try {
    const operators = Array.from({ length: 3 }, generateWallet);
    const trustedOperators = operators.map(publicWallet);
    const first = createSignedHistoryArchive(directory, chain, operators[0], {
      maxRecordsPerChunk: 1,
    });
    const second = createSignedHistoryArchive(directory, chain, operators[1], {
      maxRecordsPerChunk: 256,
    });
    assert.notEqual(first.manifest.archiveHash, second.manifest.archiveHash);
    assert.equal(first.manifest.contentRoot, second.manifest.contentRoot);
    const selected = selectHistoryArchiveCandidates([
      { archive: first, source: "archive-a.example" },
      { archive: second, source: "archive-b.example" },
    ], chain, { trustedOperators });
    assert.equal(selected.matchingSources, 2);

    const recovered = join(temporary, "recovered");
    const restored = restoreHistoryArchive(recovered, [
      { archive: first, source: "archive-a.example" },
      { archive: second, source: "archive-b.example" },
    ], chain, { trustedOperators });
    assert.equal(restored.height, chain.height);
    assert.equal(restored.matchingSources, 2);
    const index = new AccountHistoryIndex(recovered, chain);
    const page = index.page(recipient.address);
    assert.equal(page.count, 1);
    const envelope = index.transactionProof(page.entries[0].id);
    assert.equal(verifyTransactionProof(
      envelope.transaction, envelope.proof, envelope.transactionsRoot,
    ), page.entries[0].id);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("tampered chunks, one source, and duplicate operators cannot authorize recovery", () => {
  const { chain, directory, temporary } = fixture();
  try {
    const operators = Array.from({ length: 3 }, generateWallet);
    const trustedOperators = operators.map(publicWallet);
    const first = createSignedHistoryArchive(directory, chain, operators[0]);
    const second = createSignedHistoryArchive(directory, chain, operators[1]);
    const tampered = structuredClone(second);
    const original = tampered.chunks[0].data;
    tampered.chunks[0].data = `${original[0] === "A" ? "B" : "A"}${original.slice(1)}`;
    assert.throws(() => verifySignedHistoryArchive(tampered, chain, { trustedOperators }),
      /chunk hash|chunk is invalid/);
    const oversized = structuredClone(first);
    oversized.chunks[0].data += "A".repeat(4096);
    assert.throws(() => verifySignedHistoryArchive(oversized, chain, { trustedOperators }),
      /chunk is invalid/);
    const outsider = createSignedHistoryArchive(directory, chain, generateWallet());
    assert.throws(() => verifySignedHistoryArchive(outsider, chain, { trustedOperators }),
      /signer is not trusted/);
    assert.throws(() => selectHistoryArchiveCandidates([
      { archive: first, source: "archive-a.example" },
      { archive: tampered, source: "archive-b.example" },
    ], chain, { trustedOperators }), /enough independent/);
    assert.throws(() => selectHistoryArchiveCandidates([
      { archive: first, source: "archive-a.example" },
      { archive: first, source: "archive-c.example" },
    ], chain, { trustedOperators }), /operators must be independent/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
