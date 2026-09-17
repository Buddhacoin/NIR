import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import {
  createHistoryArchiveHttpServer,
  downloadHistoryArchive,
  restoreHistoryArchiveFromSources,
} from "../blockchain/archive-service.mjs";
import { loadBlockStore } from "../blockchain/block-store.mjs";
import { createTransfer } from "../blockchain/chain.mjs";
import { ATOMIC_UNITS } from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { initializeDevnet, PersistentDevNode } from "../blockchain/node-store.mjs";
import { verifyTransactionProof } from "../blockchain/transaction-tree.mjs";
import {
  createWalletFile,
  signWalletHistoryArchive,
} from "../blockchain/wallet-files.mjs";

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

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) =>
    error ? reject(error) : resolve()));
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

test("an interrupted archive activation resumes from its verified staged generation", () => {
  const { chain, directory, recipient, temporary } = fixture();
  try {
    const staging = join(directory, ".account-history-index-install");
    mkdirSync(staging, { recursive: true });
    cpSync(join(directory, "account-history-index"),
      join(staging, "account-history-index"), { recursive: true });
    cpSync(join(directory, "account-history-index-backup"),
      join(staging, "account-history-index-backup"), { recursive: true });
    writeFileSync(join(directory, "ACCOUNT-HISTORY-INSTALL.json"), JSON.stringify({
      format: "nir-account-history-install-v1",
      height: chain.height,
      networkId: chain.networkId,
      tipHash: chain.tipHash,
    }));
    rmSync(join(directory, "account-history-index"), { recursive: true, force: true });
    rmSync(join(directory, "account-history-index-backup"), { recursive: true, force: true });
    rmSync(join(staging, "account-history-index-backup"), { recursive: true, force: true });

    const recovered = new AccountHistoryIndex(directory, chain);
    assert.equal(recovered.page(recipient.address).count, 1);
    assert.equal(existsSync(join(directory, "ACCOUNT-HISTORY-INSTALL.json")), false);
    assert.equal(existsSync(staging), false);
    assert.equal(existsSync(join(directory, "account-history-index",
      "000000000002.json")), true);
    assert.equal(existsSync(join(directory, "account-history-index-backup",
      "000000000002.json")), true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("an encrypted operator vault signs an archive without exporting its private key", () => {
  const { chain, directory, temporary } = fixture();
  try {
    const path = join(temporary, "archive-operator.nirvault");
    const password = "correct horse battery staple";
    createWalletFile({ label: "archive operator", password, path });
    const archive = signWalletHistoryArchive({ chain, directory, password, path });
    const trustedOperators = [archive.signer, publicWallet(generateWallet())];
    assert.equal(verifySignedHistoryArchive(archive, chain, { trustedOperators })
      .contentRoot, archive.manifest.contentRoot);
    assert.equal(JSON.stringify(archive).includes("privateKey"), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("the operator CLI restores two independently signed archive files", () => {
  const { chain, directory, recipient, temporary } = fixture();
  try {
    const operators = [generateWallet(), generateWallet()];
    const archivePaths = operators.map((operator, index) => {
      const path = join(temporary, `operator-${index}.json`);
      writeFileSync(path, JSON.stringify(createSignedHistoryArchive(
        directory, chain, operator,
      )));
      return path;
    });
    const policyPath = join(temporary, "trusted.json");
    writeFileSync(policyPath, JSON.stringify(operators.map(publicWallet)));
    rmSync(join(directory, "account-history-index"), { recursive: true, force: true });
    rmSync(join(directory, "account-history-index-backup"), { recursive: true, force: true });
    const output = execFileSync(process.execPath, [
      join(process.cwd(), "blockchain/archive-cli.mjs"),
      "restore", directory, policyPath, ...archivePaths,
    ], { encoding: "utf8" });
    assert.equal(JSON.parse(output).matchingSources, 2);
    assert.equal(new AccountHistoryIndex(directory, chain).page(recipient.address).count, 1);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a node downloads and restores matching archives from independent services", async () => {
  const { chain, directory, recipient, temporary } = fixture();
  const operators = [generateWallet(), generateWallet()];
  const trustedOperators = operators.map(publicWallet);
  const archives = operators.map((operator, index) => createSignedHistoryArchive(
    directory, chain, operator, { maxRecordsPerChunk: index + 1 },
  ));
  const servers = archives.map(createHistoryArchiveHttpServer);
  try {
    const sources = [];
    for (const server of servers) sources.push(await listen(server));
    await assert.rejects(() => downloadHistoryArchive(sources[0], chain, {
      trustedOperators,
    }), /must use HTTPS/);
    const downloaded = await downloadHistoryArchive(sources[0], chain, {
      allowInsecureLocalhost: true, trustedOperators,
    });
    assert.equal(downloaded.archive.manifest.archiveHash,
      archives[0].manifest.archiveHash);
    await assert.rejects(() => downloadHistoryArchive(sources[0], chain, {
      allowInsecureLocalhost: true,
      maxTotalBytes: 1024,
      trustedOperators,
    }), /download budget/);

    rmSync(join(directory, "account-history-index"), { recursive: true, force: true });
    rmSync(join(directory, "account-history-index-backup"), { recursive: true, force: true });
    const chunkRequests = new Map(sources.map((source) => [new URL(source).port, 0]));
    const fetchImpl = (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes("/chunks/")) {
        chunkRequests.set(parsed.port, chunkRequests.get(parsed.port) + 1);
      }
      return fetch(url, options);
    };
    const restored = await restoreHistoryArchiveFromSources(directory, sources, chain, {
      allowInsecureLocalhost: true, fetchImpl, trustedOperators,
    });
    assert.equal(restored.matchingSources, 2);
    assert.ok(chunkRequests.get(new URL(sources[0]).port) > 0);
    assert.equal(chunkRequests.get(new URL(sources[1]).port), 0);
    assert.equal(new AccountHistoryIndex(directory, chain).page(recipient.address).count, 1);
  } finally {
    await Promise.all(servers.filter((server) => server.listening).map(close));
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("streaming recovery falls back when the first agreed operator serves a bad chunk", async () => {
  const { chain, directory, recipient, temporary } = fixture();
  const operators = [generateWallet(), generateWallet()];
  const trustedOperators = operators.map(publicWallet);
  const archives = operators.map((operator) =>
    createSignedHistoryArchive(directory, chain, operator));
  const damaged = structuredClone(archives[0]);
  const data = damaged.chunks[0].data;
  damaged.chunks[0].data = `${data[0] === "A" ? "B" : "A"}${data.slice(1)}`;
  const servers = [
    createHistoryArchiveHttpServer(damaged),
    createHistoryArchiveHttpServer(archives[1]),
  ];
  try {
    const sources = [];
    for (const server of servers) sources.push(await listen(server));
    rmSync(join(directory, "account-history-index"), { recursive: true, force: true });
    rmSync(join(directory, "account-history-index-backup"), { recursive: true, force: true });
    const restored = await restoreHistoryArchiveFromSources(directory, sources, chain, {
      allowInsecureLocalhost: true, trustedOperators,
    });
    assert.equal(restored.matchingSources, 2);
    assert.equal(new AccountHistoryIndex(directory, chain).page(recipient.address).count, 1);
  } finally {
    await Promise.all(servers.filter((server) => server.listening).map(close));
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("an untrusted remote manifest is rejected before any chunk is requested", async () => {
  const { chain, directory, temporary } = fixture();
  const trustedOperators = [publicWallet(generateWallet()), publicWallet(generateWallet())];
  const outsider = createSignedHistoryArchive(directory, chain, generateWallet());
  const server = createHistoryArchiveHttpServer(outsider);
  try {
    const source = await listen(server);
    let chunkRequests = 0;
    const fetchImpl = (url, options) => {
      if (new URL(url).pathname.includes("/chunks/")) chunkRequests += 1;
      return fetch(url, options);
    };
    await assert.rejects(() => downloadHistoryArchive(source, chain, {
      allowInsecureLocalhost: true,
      fetchImpl,
      trustedOperators,
    }), /signer is not trusted/);
    assert.equal(chunkRequests, 0);
  } finally {
    if (server.listening) await close(server);
    rmSync(temporary, { recursive: true, force: true });
  }
});
