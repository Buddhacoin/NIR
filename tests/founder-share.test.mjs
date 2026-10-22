import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NirChain, finalizeBlock, multisigAddress } from "../blockchain/chain.mjs";
import {
  FOUNDER_ALLOCATION, FOUNDER_IMMEDIATE_ALLOCATION, FOUNDER_IMMEDIATE_BPS, FOUNDER_VESTED_ALLOCATION,
  MIN_TRANSFER_FEE, SAFETY_POLICY_V1_COMMITMENT, TESTER_REWARD_RESERVE_BPS, TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  createFounderShare, createFounderTransfer, founderSigners, readFounderDescriptor, saveFounderDescriptor,
  verifyFounderDescriptor,
} from "../blockchain/founder-share.mjs";
import { createFaucetLimit, initializeSharedTestnet, startSharedTestnet } from "../blockchain/shared-testnet.mjs";
import { createWalletBridgeServer } from "../blockchain/wallet-bridge.mjs";
import { createWalletFile } from "../blockchain/wallet-files.mjs";

const members = (wallets, prefix) => wallets.map((wallet, index) => ({
  ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
}));

// A network whose genesis gives the founder share to `founderAddress`.
function networkWithFounder(founderAddress) {
  const validators = Array.from({ length: 4 }, generateWallet);
  const chain = new NirChain({
    beaconAuthorities: members(Array.from({ length: 4 }, generateWallet), "beacon"),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`, behaviorCommitment: "2".repeat(64),
      capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluators: members(Array.from({ length: 4 }, generateWallet), "evaluator"),
    founderAddress, founderImmediateBps: Number(FOUNDER_IMMEDIATE_BPS),
    genesisTimestamp: 0, networkId: "nir-founder-test",
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: generateWallet().address, treasuryImmediateBps: Number(TESTER_REWARD_RESERVE_BPS),
    validators: members(validators, "validator"),
  });
  const append = (transactions, timestamp) => {
    const proposal = chain.buildBlock({ timestamp, transactions });
    const quorum = [validators.find(({ address }) => address === proposal.proposer),
      ...validators.filter(({ address }) => address !== proposal.proposer)].slice(0, 3);
    chain.appendBlock(finalizeBlock(proposal, quorum));
  };
  return { append, chain };
}

test("three phrases make the founder's 2-of-3 address in the genesis plan's format", () => {
  const { descriptor, phrases } = createFounderShare();
  assert.equal(phrases.length, 3);
  assert.equal(new Set(phrases).size, 3);
  for (const phrase of phrases) assert.equal(phrase.split(" ").length, 24);
  assert.equal(descriptor.address, multisigAddress(descriptor.memberPublicKeys, 2));
  assert.deepEqual(descriptor.vestingPolicy, { allocationBps: 700, durationMs: TREASURY_VESTING_MS,
    immediateBps: 100, model: "genesis-release-plus-linear" });
  assert.deepEqual(verifyFounderDescriptor(structuredClone(descriptor)), descriptor);
  assert.throws(() => verifyFounderDescriptor({ ...descriptor, address: generateWallet().address }), /invalid/);
  assert.throws(() => verifyFounderDescriptor({ ...descriptor,
    vestingPolicy: { ...descriptor.vestingPolicy, immediateBps: 200 } }), /invalid/);

  // Any two phrases sign; one, a repeated one or a stranger's does not.
  assert.equal(founderSigners(descriptor, [phrases[2], phrases[0]]).length, 2);
  assert.equal(founderSigners(descriptor, [` ${phrases[1].toUpperCase()}  `, phrases[2]]).length, 2);
  assert.throws(() => founderSigners(descriptor, [phrases[0]]), /two different/);
  assert.throws(() => founderSigners(descriptor, [phrases[0], phrases[0]]), /twice/);
  assert.throws(() => founderSigners(descriptor, [phrases[0], createFounderShare().phrases[0]]),
    /does not belong/);
  assert.throws(() => founderSigners(descriptor, [phrases[0], "word ".repeat(24)]), /not a valid/);
});

test("NIR Wallet keeps only the public founder descriptor, once", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-founder-"));
  try {
    assert.equal(readFounderDescriptor(directory), null);
    const { descriptor, phrases } = createFounderShare();
    saveFounderDescriptor(directory, descriptor);
    const saved = readFileSync(join(directory, "founder-share.json"), "utf8");
    for (const phrase of phrases) assert.equal(saved.includes(phrase.split(" ")[0] + " "), false);
    assert.deepEqual(readFounderDescriptor(directory), descriptor);
    assert.throws(() => saveFounderDescriptor(directory, createFounderShare().descriptor), /already exists/);
    assert.deepEqual(readFounderDescriptor(directory), descriptor);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("two founder phrases move the open part of the share and nothing still locked", () => {
  const { descriptor, phrases } = createFounderShare();
  const { append, chain } = networkWithFounder(descriptor.address);
  const recipient = generateWallet().address;
  assert.equal(chain.balance(descriptor.address), FOUNDER_ALLOCATION);
  assert.deepEqual(chain.genesisAllocations().founder,
    { address: descriptor.address, locked: FOUNDER_VESTED_ALLOCATION.toString() });
  const transfer = (amount, nonce, signers = [phrases[0], phrases[2]]) => createFounderTransfer({
    amount: amount.toString(), descriptor, networkId: chain.networkId, nonce, phrases: signers, recipient });

  assert.throws(() => append([transfer(FOUNDER_IMMEDIATE_ALLOCATION, 0)], 0), /still vesting/);
  append([transfer(FOUNDER_IMMEDIATE_ALLOCATION - MIN_TRANSFER_FEE, 0)], 0);
  assert.equal(chain.balance(recipient), FOUNDER_IMMEDIATE_ALLOCATION - MIN_TRANSFER_FEE);

  // Half of the ten years later, half of the locked part is open.
  const midpoint = TREASURY_VESTING_MS / 2;
  append([], midpoint);
  assert.equal(chain.genesisAllocations().founder.locked, (FOUNDER_VESTED_ALLOCATION / 2n).toString());
  assert.throws(() => append([transfer(FOUNDER_VESTED_ALLOCATION / 2n, 1, [phrases[1], phrases[0]])],
    midpoint + 1), /still vesting/);
  append([transfer(FOUNDER_VESTED_ALLOCATION / 2n - MIN_TRANSFER_FEE, 1, [phrases[1], phrases[0]])], midpoint + 1);
  assert.equal(chain.balance(descriptor.address), FOUNDER_VESTED_ALLOCATION / 2n);
});

test("nodes report the genesis allocations; the shared test network has no founder share", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-allocations-"));
  try {
    initializeSharedTestnet(join(directory, "server"), { proofMiningInitialLevel: 8 });
    const running = await startSharedTestnet({ directory: join(directory, "server"), port: 0, tickMs: 1_000, faucetLimit: createFaucetLimit() });
    try {
      const response = await fetch(`http://127.0.0.1:${running.server.address().port}/v1/allocations`);
      assert.equal(response.status, 200);
      const allocations = await response.json();
      assert.equal(allocations.founder, null);
      assert.match(allocations.treasury.address, /^nir1[0-9a-f]{64}$/);
      assert.equal(allocations.networkId, "nir-shared-testnet-1");
      assert.match(allocations.chainIdentityGenesisHash, /^[0-9a-f]{64}$/);
    } finally {
      await running.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("NIR Wallet's bridge gives the page the founder address and a signed transfer to itself, never phrases",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "nir-founder-bridge-"));
    const { descriptor, phrases } = createFounderShare();
    let saved = null;
    let answer = [phrases[1], phrases[2]];
    const vaultPath = join(directory, "wallet.nirvault.json");
    const { address } = createWalletFile({ path: vaultPath, password: "founder-bridge-password-2026" });
    const origin = "http://127.0.0.1:8765";
    const token = "b".repeat(64);
    const bridge = createWalletBridgeServer({ authorize: async () => null, origin, sessionToken: token, vaultPath,
      founderShare: {
        read: () => saved,
        create: async () => { saved = descriptor; return "created"; },
        sign: async (request) => answer && createFounderTransfer({ ...request, phrases: answer }),
      } });
    const plain = createWalletBridgeServer({ authorize: async () => null, origin, sessionToken: token, vaultPath });
    await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => plain.listen(0, "127.0.0.1", resolve));
    const call = async (server, path, body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        headers: { "content-type": "application/json", origin, "x-nir-bridge-token": token } });
      return { status: response.status, value: await response.json() };
    };
    try {
      assert.equal((await call(plain, "/v1/founder")).status, 404);
      assert.deepEqual((await call(bridge, "/v1/founder")).value, { descriptor: null });
      const request = { amount: "1000", chainIdentityGenesisHash: "c".repeat(64), networkId: "nir-founder-test",
        nonce: 0, requestId: "a".repeat(64) };
      assert.equal((await call(bridge, "/v1/founder/transfer", request)).value.error,
        "there is no founder address on this Mac");
      const created = await call(bridge, "/v1/founder/create", {});
      assert.deepEqual(created.value, { descriptor, outcome: "created" });
      assert.equal(JSON.stringify(created.value).includes(phrases[0].split(" ")[0] + " "), false);

      assert.equal((await call(bridge, "/v1/founder/transfer", { ...request, amount: "0" })).value.error,
        "founder request is invalid");
      assert.equal((await call(bridge, "/v1/founder/transfer", { ...request, recipient: descriptor.address }))
        .value.error, "founder request is invalid");
      const signed = await call(bridge, "/v1/founder/transfer", { ...request, requestId: "b".repeat(64) });
      assert.equal(signed.value.outcome, "signed");
      assert.equal(signed.value.transaction.sender, descriptor.address);
      assert.equal(signed.value.transaction.recipient, address);
      assert.equal(signed.value.transaction.signatures.length, 2);
      assert.equal((await call(bridge, "/v1/founder/transfer", { ...request, requestId: "b".repeat(64) })).status, 409);
      answer = null;
      assert.equal((await call(bridge, "/v1/founder/transfer", { ...request, requestId: "d".repeat(64) }))
        .value.outcome, "cancelled");
    } finally {
      bridge.close();
      plain.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
