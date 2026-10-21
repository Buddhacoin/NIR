import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createNameTransaction } from "../blockchain/chain.mjs";
import { ATOMIC_UNITS, NAME_REGISTRY_PROTOCOL_VERSION } from "../blockchain/constants.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import {
  applyNameCommit, applyNameRegister, createNameRegistryState, endNameRegistryBlock, nameCommitment,
  namePrice, nameProblem, normalizeNameInput, parseNameRegistrySnapshot,
} from "../blockchain/name-registry.mjs";
import { createDeveloperNodeHttpServer } from "../blockchain/node-service.mjs";
import { initializeDevnet, PersistentDevNode } from "../blockchain/node-store.mjs";

test("names are short, plain and cannot imitate NIR", () => {
  for (const name of ["sasha", "abc", "a-b", "x2026", "a".repeat(32)]) assert.equal(nameProblem(name), null, name);
  assert.equal(nameProblem("ab"), "length");
  assert.equal(nameProblem("a".repeat(33)), "length");
  for (const name of ["Sasha", "-abc", "abc-", "a--b", "sa_sha", "саша", "sasha.nir"]) {
    assert.equal(nameProblem(name), "characters", name);
  }
  for (const name of ["nir", "nirwallet", "nir-support", "support", "admin", "wallet"]) {
    assert.equal(nameProblem(name), "reserved", name);
  }
  assert.equal(normalizeNameInput("  Sasha.NIR "), "sasha");
  assert.equal(normalizeNameInput("nir1abc"), null);
  assert.equal(namePrice("abc"), 50n * ATOMIC_UNITS);
  assert.equal(namePrice("abcd"), 10n * ATOMIC_UNITS);
  assert.equal(namePrice("abcde"), ATOMIC_UNITS);
});

test("a name needs an earlier hidden commit from the same owner", () => {
  const state = createNameRegistryState();
  const owner = `nir1${"a".repeat(64)}`;
  const thief = `nir1${"b".repeat(64)}`;
  const salt = "c".repeat(64);
  const commitment = nameCommitment({ name: "sasha", networkId: "n", owner, salt });
  applyNameCommit(state, { commitment, sender: owner, height: 10 });
  // Seeing the name in flight is not enough: the thief has no commit for it.
  assert.throws(() => applyNameRegister(state, { name: "sasha", networkId: "n", salt, sender: thief, height: 12 }),
    /has no commit/);
  assert.throws(() => applyNameRegister(state, { name: "sasha", networkId: "n", salt, sender: owner, height: 11 }),
    /outside its window/);
  assert.equal(applyNameRegister(state, { name: "sasha", networkId: "n", salt, sender: owner, height: 12 }),
    ATOMIC_UNITS);
  assert.deepEqual(parseNameRegistrySnapshot(JSON.parse(JSON.stringify({
    commits: [], names: [["sasha", { height: 12, owner }]], owners: [[owner, "sasha"]] }))).owners.get(owner), "sasha");
  assert.throws(() => parseNameRegistrySnapshot({ commits: [], names: [["sasha", { height: 12, owner }]],
    owners: [[thief, "sasha"]] }), /do not match/);
  // Unused commits expire.
  applyNameCommit(state, { commitment: "d".repeat(64), sender: thief, height: 20 });
  endNameRegistryBlock(state, { height: 20 + 257 });
  assert.equal(state.commits.size, 0);
});

test("a devnet registers, changes, gives away and releases names, burning the price", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-names-"));
  try {
    const directory = join(temporary, "node");
    const created = initializeDevnet(directory, { proofMining: true, proofMiningInitialLevel: 8 });
    assert.equal(created.protocolVersion, NAME_REGISTRY_PROTOCOL_VERSION);
    const node = new PersistentDevNode(directory);
    const info = node.nameRegistry();
    assert.equal(info.active, true);
    const alice = generateWallet();
    const bob = generateWallet();
    node.faucet(alice.address);
    node.faucet(bob.address);
    const send = (wallet, fields) => node.submitTransaction(createNameTransaction({
      wallet, networkId: info.networkId, chainIdentityGenesisHash: info.chainIdentityGenesisHash,
      nonce: node.account(wallet.address).nextNonce, ...fields }));
    const register = (wallet, name) => {
      const salt = randomBytes(32).toString("hex");
      send(wallet, { type: "name-commit",
        commitment: nameCommitment({ name, networkId: info.networkId, owner: wallet.address, salt }) });
      node.tick();
      node.tick();
      send(wallet, { type: "name-register", name, salt });
    };
    const before = BigInt(node.account(alice.address).atomicBalance);
    register(alice, "alice");
    assert.deepEqual(node.accountName(alice.address), { address: alice.address, name: "alice" });
    assert.equal(node.nameLookup("Alice.nir").owner, alice.address);
    assert.equal(node.nameLookup("alice").available, false);
    // Wallets read the same over HTTP from the miner's devnet.
    const server = createDeveloperNodeHttpServer(node);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      assert.equal((await (await fetch(`${base}/v1/names/alice.nir`)).json()).owner, alice.address);
      assert.equal((await (await fetch(`${base}/v1/accounts/${alice.address}/name`)).json()).name, "alice");
      assert.equal((await (await fetch(`${base}/v1/names`)).json()).active, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    // One NIR is burned, plus the three transaction fees.
    assert.ok(before - BigInt(node.account(alice.address).atomicBalance) > ATOMIC_UNITS);
    // Someone else cannot take it, even with their own commit.
    assert.throws(() => register(bob, "alice"), /already taken/);
    // Changing the name frees the old one.
    register(alice, "alice-new");
    assert.equal(node.nameLookup("alice").available, true);
    assert.equal(node.accountName(alice.address).name, "alice-new");
    // Giving the name away: the receiver must have none.
    send(alice, { type: "name-transfer", recipient: bob.address });
    assert.equal(node.accountName(bob.address).name, "alice-new");
    assert.equal(node.accountName(alice.address).name, null);
    send(bob, { type: "name-release" });
    assert.equal(node.nameLookup("alice-new").available, true);
    assert.equal(node.nameLookup("support").problem, "reserved");
    // A restarted node replays the stored chain to the same names.
    assert.deepEqual(new PersistentDevNode(directory).nameRegistry(), node.nameRegistry());
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
