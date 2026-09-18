import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createWalletBridgeServer } from "../blockchain/wallet-bridge.mjs";
import { createWalletFile } from "../blockchain/wallet-files.mjs";
import { createAccountProof } from "../blockchain/account-proof.mjs";
import { createAssetProof } from "../blockchain/asset-proof.mjs";
import { createValidatorHandoff } from "../blockchain/validator-handoff.mjs";
import { createTransfer, finalizeBlock, nativeAssetId, NirChain } from "../blockchain/chain.mjs";
import {
  MIN_TRANSFER_FEE,
  SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { createFinalityProof } from "../blockchain/light-client.mjs";
import {
  committedTransactionId,
  createTransactionProof,
} from "../blockchain/transaction-tree.mjs";
import {
  createAccountHistoryProof,
  emptyAccountHistory,
} from "../blockchain/account-history.mjs";

async function close(server) {
  if (!server.listening) return;
  const done = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await done;
}

function request(url, origin, token, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      origin,
      "x-nir-bridge-token": token,
      ...options.headers,
    },
  });
}

function validatorMembers(wallets) {
  return wallets.map((wallet) => ({
    ...publicWallet(wallet), operatorId: `validator-${wallet.address.slice(4, 16)}`,
  }));
}

test("wallet checkpoint advances only through a verified finality header chain", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-light-client-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const wallet = createWalletFile({ path: vaultPath, password: "wallet-light-client-password" });
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const members = validatorMembers(validators);
  const networkId = "nir-wallet-light-client";
  const treasury = generateWallet();
  const chain = new NirChain({
    beaconAuthorities: beacons.map((entry, index) => ({
      ...publicWallet(entry), operatorId: `beacon-${index}`,
    })),
    capabilityReferences: [{
      artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 },
    }],
    evaluators: evaluators.map((entry, index) => ({
      ...publicWallet(entry), operatorId: `evaluator-${index}`,
    })),
    genesisTimestamp: 0,
    networkId,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: members,
  });
  const append = (timestamp, transactions = []) => {
    const block = finalizeBlock(
      chain.buildBlock({ timestamp, transactions }), validators.slice(0, 3),
    );
    chain.appendBlock(block);
    return block;
  };
  const account = (height) => {
    const authenticated = chain.accountStateProof(wallet.address);
    return createAccountProof({
      account: authenticated.account,
      accountStateRoot: authenticated.accountStateRoot,
      inclusionProof: authenticated.inclusionProof,
      height, networkId, stateRoot: chain.stateRoot, tipHash: chain.tipHash,
      validators: members, validatorWallets: validators.slice(0, 3),
    });
  };
  const genesisBlock = chain.blocks()[0];
  const firstBlock = append(1);
  const origin = "http://127.0.0.1:8765";
  const token = "6".repeat(64);
  const server = createWalletBridgeServer({
    authorize: async () => "wallet-light-client-password",
    origin, sessionToken: token,
    trustAnchor: {
      expectedNetworkId: networkId,
      genesisCheckpoint: {
        accountStateRoot: genesisBlock.accountStateRoot,
        height: 0,
        stateRoot: genesisBlock.stateRoot,
        tipHash: genesisBlock.hash,
        validatorSetId: chain.validatorSetId,
      },
      handoffs: [], trustedValidators: members,
    },
    headerHistoryPath: join(directory, "wallet.headers.json"),
    trustCheckpointPath: join(directory, "wallet.trust.json"), vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const unverifiedBootstrap = await request(
      `${base}/v1/verify-account-proof`, origin, token, {
        body: JSON.stringify({ address: wallet.address, minimumHeight: 1, proof: account(1) }),
        method: "POST",
      },
    );
    assert.equal(unverifiedBootstrap.status, 400);
    assert.match((await unverifiedBootstrap.json()).error, /verified finality chain/);
    const firstSync = await request(`${base}/v1/verify-finality-chain`, origin, token, {
      body: JSON.stringify({ proofs: [createFinalityProof(firstBlock)] }), method: "POST",
    });
    assert.equal(firstSync.status, 200);
    const bootstrap = await request(`${base}/v1/verify-account-proof`, origin, token, {
      body: JSON.stringify({ address: wallet.address, minimumHeight: 1, proof: account(1) }),
      method: "POST",
    });
    assert.equal(bootstrap.status, 200);
    const transfer = createTransfer({
      amount: "100000000",
      fee: MIN_TRANSFER_FEE.toString(),
      networkId,
      nonce: 0,
      recipient: wallet.address,
      wallet: treasury,
    });
    const second = append(TREASURY_VESTING_MS, [transfer]);
    const laterProof = account(2);
    const premature = await request(`${base}/v1/verify-account-proof`, origin, token, {
      body: JSON.stringify({ address: wallet.address, minimumHeight: 2, proof: laterProof }),
      method: "POST",
    });
    assert.equal(premature.status, 400);
    assert.match((await premature.json()).error, /verified finality chain/);
    const lightSync = await request(`${base}/v1/verify-finality-chain`, origin, token, {
      body: JSON.stringify({ proofs: [createFinalityProof(second)] }), method: "POST",
    });
    assert.equal(lightSync.status, 200);
    assert.equal((await lightSync.json()).tip.height, 2);
    const transactionEnvelope = {
      blockHash: second.hash,
      height: second.height,
      proof: createTransactionProof(second.transactions, 0),
      transaction: transfer,
      transactionsRoot: second.transactionsRoot,
    };
    const verifiedTransaction = await request(
      `${base}/v1/verify-transaction-proof`, origin, token, {
        body: JSON.stringify({
          proof: transactionEnvelope,
          transactionId: committedTransactionId(second.transactions[0]),
        }),
        method: "POST",
      },
    );
    assert.equal(verifiedTransaction.status, 200);
    assert.equal((await verifiedTransaction.json()).height, 2);
    const forgedTransaction = await request(
      `${base}/v1/verify-transaction-proof`, origin, token, {
        body: JSON.stringify({
          proof: { ...transactionEnvelope, transaction: { ...transfer, amount: "200000000" } },
        }),
        method: "POST",
      },
    );
    assert.equal(forgedTransaction.status, 400);
    const accepted = await request(`${base}/v1/verify-account-proof`, origin, token, {
      body: JSON.stringify({ address: wallet.address, minimumHeight: 2, proof: laterProof }),
      method: "POST",
    });
    assert.equal(accepted.status, 200);
    const newAssetId = nativeAssetId({ creator: wallet.address, networkId, nonce: 0 });
    const assetProof = createAssetProof({ asset: null, assetId: newAssetId, balance: "0",
      height: 2, holder: wallet.address, networkId, stateRoot: chain.stateRoot,
      tipHash: chain.tipHash, validators: members, validatorWallets: validators.slice(0, 3) });
    const verifiedAsset = await request(`${base}/v1/verify-asset-proof`, origin, token, {
      body: JSON.stringify({ assetId: newAssetId, holder: wallet.address, minimumHeight: 2, proof: assetProof }),
      method: "POST",
    });
    assert.equal(verifiedAsset.status, 200);
    const staleAsset = await request(`${base}/v1/verify-asset-proof`, origin, token, {
      body: JSON.stringify({ assetId: newAssetId, holder: wallet.address, minimumHeight: 3, proof: assetProof }),
      method: "POST",
    });
    assert.equal(staleAsset.status, 400);
    const assetSimulation = await request(`${base}/v1/simulate-transaction`, origin, token, {
      body: JSON.stringify({ intent: { type: "asset-create", assetId: newAssetId,
        fee: MIN_TRANSFER_FEE.toString(), fixedSupply: false, initialSupply: "10", maxSupply: "100",
        metadataHash: "9".repeat(64), networkId, nonce: 0 }, network: { height: 2, networkId },
      verifiedAccount: { address: wallet.address, height: 2, proofVerified: true } }), method: "POST",
    });
    assert.equal(assetSimulation.status, 200);
    const assetSimulationBody = await assetSimulation.json();
    assert.equal(assetSimulationBody.simulation.deltas.asset[0].supplyAfter, "10");
    const offlineAsset = await request(`${base}/v1/create-offline-signing-package`, origin, token, {
      body: JSON.stringify({ simulationId: assetSimulationBody.simulation.simulationId }), method: "POST",
    });
    assert.equal(offlineAsset.status, 200);
    assert.equal((await offlineAsset.json()).signingPackage.intent.type, "asset-create");
    const browserAssetSigning = await request(`${base}/v1/sign-resource`, origin, token, {
      body: JSON.stringify({ ...assetSimulationBody.simulation.intent,
        requestId: "8".repeat(64), simulationId: assetSimulationBody.simulation.simulationId }),
      method: "POST",
    });
    assert.equal(browserAssetSigning.status, 400);
    assert.match((await browserAssetSigning.json()).error, /resource intent is invalid/);
    const unprovenSimulation = await request(`${base}/v1/simulate-transaction`, origin, token, {
      body: JSON.stringify({
        intent: { amount: "1", fee: MIN_TRANSFER_FEE.toString(), networkId, nonce: 0,
          recipient: treasury.address, type: "transfer" },
        network: { height: 2, networkId },
      }), method: "POST",
    });
    assert.equal(unprovenSimulation.status, 400);
    assert.match((await unprovenSimulation.json()).error, /verified account proof/);
    const simulated = await request(`${base}/v1/simulate-transaction`, origin, token, {
      body: JSON.stringify({
        intent: { amount: "1", fee: MIN_TRANSFER_FEE.toString(), networkId, nonce: 0,
          recipient: treasury.address, type: "transfer" },
        network: { height: 2, networkId },
        verifiedAccount: { address: wallet.address, height: 2, proofVerified: true },
      }), method: "POST",
    });
    assert.equal(simulated.status, 200);
    const simulation = await simulated.json();
    assert.equal(simulation.verified, true);
    assert.equal(simulation.simulation.deltas.balance[0].atomicDelta, "-1001");
    assert.equal(simulation.simulation.proof.verified, true);
    const unsignedWithoutReview = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify({
        amount: "1", fee: MIN_TRANSFER_FEE.toString(), networkId, nonce: 0,
        recipient: treasury.address, requestId: "e".repeat(64),
      }), method: "POST",
    });
    assert.equal(unsignedWithoutReview.status, 400);
    assert.match((await unsignedWithoutReview.json()).error, /simulation is required/);
    const changedAfterReview = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify({
        amount: "2", fee: MIN_TRANSFER_FEE.toString(), networkId, nonce: 0,
        recipient: treasury.address, requestId: "d".repeat(64),
        simulationId: simulation.simulation.simulationId,
      }), method: "POST",
    });
    assert.equal(changedAfterReview.status, 400);
    assert.match((await changedAfterReview.json()).error, /differs from the reviewed simulation/);
    const signedAfterReview = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify({
        amount: "1", fee: MIN_TRANSFER_FEE.toString(), networkId, nonce: 0,
        recipient: treasury.address, requestId: "e".repeat(64),
        simulationId: simulation.simulation.simulationId,
      }), method: "POST",
    });
    assert.equal(signedAfterReview.status, 200);
    assert.equal((await signedAfterReview.json()).simulationId, simulation.simulation.simulationId);
    const paymentExpiresAt = Date.now() + 60_000;
    const paymentPreview = await request(`${base}/v1/simulate-transaction`, origin, token, {
      body: JSON.stringify({
        intent: { amount: "1", expiresAt: paymentExpiresAt, memo: "preview", networkId,
          requestId: "f".repeat(64), type: "payment-request" },
        network: { height: 2, networkId },
        verifiedAccount: { address: wallet.address, height: 2, proofVerified: true },
      }), method: "POST",
    });
    assert.equal(paymentPreview.status, 200);
    const paymentPreviewValue = await paymentPreview.json();
    const unsignedRequestWithoutReview = await request(`${base}/v1/sign-payment-request`, origin, token, {
      body: JSON.stringify({
        amount: "1", expiresAt: paymentExpiresAt, memo: "preview", networkId,
        requestId: "0".repeat(64),
      }), method: "POST",
    });
    assert.equal(unsignedRequestWithoutReview.status, 400);
    assert.match((await unsignedRequestWithoutReview.json()).error, /simulation is required/);
    const changedPaymentPreview = await request(`${base}/v1/sign-payment-request`, origin, token, {
      body: JSON.stringify({
        amount: "2", expiresAt: paymentExpiresAt, memo: "preview", networkId,
        requestId: "f".repeat(64), simulationId: paymentPreviewValue.simulation.simulationId,
      }), method: "POST",
    });
    assert.equal(changedPaymentPreview.status, 400);
    assert.match((await changedPaymentPreview.json()).error, /differs from the reviewed simulation/);
    const signedPaymentPreview = await request(`${base}/v1/sign-payment-request`, origin, token, {
      body: JSON.stringify({
        amount: "1", expiresAt: paymentExpiresAt, memo: "preview", networkId,
        requestId: "f".repeat(64), simulationId: paymentPreviewValue.simulation.simulationId,
      }), method: "POST",
    });
    assert.equal(signedPaymentPreview.status, 200);
    assert.equal((await signedPaymentPreview.json()).paymentRequest.recipient, wallet.address);
    const completeHistory = await request(
      `${base}/v1/verify-account-history`, origin, token, {
        body: JSON.stringify({ transactionIds: [committedTransactionId(transfer)] }),
        method: "POST",
      },
    );
    assert.equal(completeHistory.status, 200);
    assert.equal((await completeHistory.json()).count, 1);
    const omittedHistory = await request(
      `${base}/v1/verify-account-history`, origin, token, {
        body: JSON.stringify({ transactionIds: [] }), method: "POST",
      },
    );
    assert.equal(omittedHistory.status, 400);
    assert.match((await omittedHistory.json()).error, /incomplete or reordered/);
    const page = {
      count: 1,
      entries: [{
        id: committedTransactionId(transfer),
        index: 0,
        proof: createAccountHistoryProof([committedTransactionId(transfer)], 0),
      }],
      nextBefore: null,
      start: 0,
    };
    const verifiedPage = await request(
      `${base}/v1/verify-account-history-page`, origin, token, {
        body: JSON.stringify({ before: 1, limit: 20, page }), method: "POST",
      },
    );
    assert.equal(verifiedPage.status, 200);
    const missingPage = await request(
      `${base}/v1/verify-account-history-page`, origin, token, {
        body: JSON.stringify({ before: 1, limit: 20, page: { ...page, entries: [] } }),
        method: "POST",
      },
    );
    assert.equal(missingPage.status, 400);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet account trust advances through verified validator handoffs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-proof-rotation-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const account = createWalletFile({ path: vaultPath, password: "wallet-proof-password-long" });
  const first = Array.from({ length: 4 }, generateWallet);
  const second = [first[0], first[1], generateWallet(), generateWallet()];
  const firstMembers = validatorMembers(first);
  const secondMembers = validatorMembers(second);
  const networkId = "nir-wallet-rotation-test";
  const handoff = createValidatorHandoff({
    activationBlockHash: "a".repeat(64),
    activationHeight: 10,
    activationStateRoot: "b".repeat(64),
    networkId,
    nextValidators: secondMembers,
    previousValidators: firstMembers,
  }, first.slice(0, 3), second.slice(0, 3));
  const accountState = {
    address: account.address,
    atomicBalance: "500000000",
    history: emptyAccountHistory(),
    nextNonce: 2,
    resources: {
      atomicStake: "0", availableTransferCredits: "0", delegations: [], pendingUnstake: null,
    },
  };
  const proof = createAccountProof({
    account: accountState,
    height: 10,
    networkId,
    stateRoot: "b".repeat(64),
    tipHash: "a".repeat(64),
    validators: secondMembers,
    validatorWallets: second.slice(0, 3),
  });
  const staleAuthority = createAccountProof({
    account: accountState,
    height: 10,
    networkId,
    stateRoot: "b".repeat(64),
    tipHash: "a".repeat(64),
    validators: firstMembers,
    validatorWallets: first.slice(0, 3),
  });
  const origin = "http://127.0.0.1:8765";
  const token = "0".repeat(64);
  const trustCheckpointPath = join(directory, "wallet.trust.json");
  const trustHistoryPath = join(directory, "wallet.handoffs.json");
  const server = createWalletBridgeServer({
    authorize: async () => null,
    origin,
    sessionToken: token,
    trustAnchor: {
      expectedNetworkId: networkId,
      handoffs: [],
      trustedValidators: firstMembers,
    },
    trustCheckpointPath,
    trustHistoryPath,
    vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const updated = await request(`${base}/v1/update-validator-trust`, origin, token, {
      body: JSON.stringify({ handoffs: [handoff] }), method: "POST",
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).handoffs, 1);
    assert.equal(existsSync(trustHistoryPath), true);
    const verified = await request(`${base}/v1/verify-account-proof`, origin, token, {
      body: JSON.stringify({ address: account.address, minimumHeight: 10, proof }), method: "POST",
    });
    assert.equal(verified.status, 200);
    assert.equal((await verified.json()).verified, true);
    assert.equal(existsSync(trustCheckpointPath), true);
    const rejected = await request(`${base}/v1/verify-account-proof`, origin, token, {
      body: JSON.stringify({
        address: account.address, minimumHeight: 10, proof: staleAuthority,
      }),
      method: "POST",
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /trust anchor/);
    const wrongActivationProof = createAccountProof({
      account: accountState,
      height: 10,
      networkId,
      stateRoot: "c".repeat(64),
      tipHash: "d".repeat(64),
      validators: secondMembers,
      validatorWallets: second.slice(0, 3),
    });
    const wrongActivation = await request(
      `${base}/v1/verify-account-proof`, origin, token, {
        body: JSON.stringify({
          address: account.address, minimumHeight: 10, proof: wrongActivationProof,
        }),
        method: "POST",
      },
    );
    assert.equal(wrongActivation.status, 400);
    assert.match((await wrongActivation.json()).error, /activation block/);
    await close(server);
    assert.throws(() => createWalletBridgeServer({
      authorize: async () => null,
      origin,
      sessionToken: token,
      trustAnchor: {
        expectedNetworkId: networkId,
        handoffs: [],
        trustedValidators: firstMembers,
      },
      trustCheckpointPath,
      vaultPath,
    }), /rolls back/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge requires a verified simulation before an exact-origin signing request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-bridge-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const password = "wallet-bridge-password-long";
  const wallet = createWalletFile({ path: vaultPath, password });
  const recipient = generateWallet();
  const origin = "http://127.0.0.1:8765";
  const token = "a".repeat(64);
  const approvals = [];
  const server = createWalletBridgeServer({
    authorize: async (intent) => { approvals.push(intent); return password; },
    origin, sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await request(`${base}/v1/wallet`, "http://evil.invalid", token)).status, 403);
    assert.equal((await request(`${base}/v1/wallet`, origin, "b".repeat(64))).status, 401);
    const publicInfo = await request(`${base}/v1/wallet`, origin, token);
    assert.equal(publicInfo.status, 200);
    assert.equal((await publicInfo.json()).address, wallet.address);

    const intent = {
      amount: "250000000",
      networkId: "nir-testnet",
      nonce: 0,
      recipient: recipient.address,
      requestId: "c".repeat(64),
    };
    const signed = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent), method: "POST",
    });
    assert.equal(signed.status, 400);
    assert.match((await signed.json()).error, /simulation is required/);
    assert.equal(approvals.length, 0);
    const replay = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent), method: "POST",
    });
    assert.equal(replay.status, 400);
    assert.match((await replay.json()).error, /simulation is required/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge never broadcasts a request that has no reviewed simulation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-bridge-reject-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "wallet-bridge-password-long" });
  const recipient = generateWallet();
  const origin = "http://localhost:8765";
  const token = "d".repeat(64);
  const server = createWalletBridgeServer({
    authorize: async () => null, origin, sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const intent = {
      amount: "1", networkId: "nir-testnet", nonce: 0,
      recipient: recipient.address, requestId: "e".repeat(64),
    };
    const rejected = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent), method: "POST",
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /simulation is required/);
    assert.equal((await request(`${base}/v1/transactions`, origin, token, {
      body: "{}", method: "POST",
    })).status, 404);
    const replay = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent), method: "POST",
    });
    assert.equal(replay.status, 400);
    assert.match((await replay.json()).error, /simulation is required/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge rejects a resource operation without a reviewed simulation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-resource-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const password = "wallet-resource-password-long";
  createWalletFile({ path: vaultPath, password });
  const origin = "http://127.0.0.1:8765";
  const token = "3".repeat(64);
  const server = createWalletBridgeServer({
    authorize: async () => password, origin, sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const signed = await request(`${base}/v1/sign-resource`, origin, token, {
      body: JSON.stringify({
        amount: "10000000000", fee: "1000", networkId: "nir-testnet", nonce: 0,
        requestId: "4".repeat(64), type: "credit-stake",
      }),
      method: "POST",
    });
    assert.equal(signed.status, 400);
    assert.match((await signed.json()).error, /simulation is required/);

    const invalid = await request(`${base}/v1/sign-resource`, origin, token, {
      body: JSON.stringify({
        networkId: "nir-testnet", nonce: 1, requestId: "5".repeat(64), type: "validator-bond",
      }),
      method: "POST",
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /invalid/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge rejects payment-request signing without a reviewed simulation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-request-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const password = "wallet-payment-request-password";
  const wallet = createWalletFile({ path: vaultPath, password });
  const origin = "http://127.0.0.1:8765";
  const token = "7".repeat(64);
  const server = createWalletBridgeServer({
    authorize: async () => password, origin, sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const signed = await request(`${base}/v1/sign-payment-request`, origin, token, {
      body: JSON.stringify({
        amount: "300000000",
        expiresAt: Date.now() + 3_600_000,
        memo: "Invoice 17",
        networkId: "nir-testnet",
        requestId: "8".repeat(64),
      }),
      method: "POST",
    });
    assert.equal(signed.status, 400);
    assert.match((await signed.json()).error, /simulation is required/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge rejects unreviewed requests before opening a confirmation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-bridge-lock-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const password = "wallet-bridge-password-long";
  createWalletFile({ path: vaultPath, password });
  const recipient = generateWallet();
  const origin = "http://127.0.0.1:8765";
  const token = "f".repeat(64);
  let releaseApproval;
  let approvalStarted;
  const started = new Promise((resolve) => { approvalStarted = resolve; });
  const server = createWalletBridgeServer({
    authorize: async () => {
      approvalStarted();
      return new Promise((resolve) => { releaseApproval = () => resolve(password); });
    },
    origin, sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const intent = (requestId) => ({
      amount: "1", networkId: "nir-testnet", nonce: 0,
      recipient: recipient.address, requestId,
    });
    const first = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent("1".repeat(64))), method: "POST",
    });
    const second = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent("2".repeat(64))), method: "POST",
    });
    assert.equal(first.status, 400);
    assert.match((await first.json()).error, /simulation is required/);
    assert.equal(second.status, 400);
    assert.match((await second.json()).error, /simulation is required/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge exchanges a short-lived one-time code for one in-memory session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-bridge-pair-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "wallet-bridge-password-long" });
  const origin = "http://127.0.0.1:8765";
  const token = "9".repeat(64);
  const server = createWalletBridgeServer({
    authorize: async () => null,
    origin,
    pairingCode: "12345678",
    sessionToken: token,
    vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const wrong = await request(`${base}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "00000000" }), method: "POST",
    });
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /invalid/);
    const paired = await request(`${base}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "12345678" }), method: "POST",
    });
    assert.equal(paired.status, 200);
    assert.deepEqual(await paired.json(), { sessionToken: token });
    const reused = await request(`${base}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "12345678" }), method: "POST",
    });
    assert.equal(reused.status, 400);
    assert.match((await reused.json()).error, /unavailable/);
    assert.equal((await request(`${base}/v1/wallet`, origin, token)).status, 200);
    const disconnected = await request(`${base}/v1/session`, origin, token, {
      method: "DELETE",
    });
    assert.equal(disconnected.status, 200);
    assert.deepEqual(await disconnected.json(), { disconnected: true });
    assert.equal((await request(`${base}/v1/wallet`, origin, token)).status, 401);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge disables pairing after five incorrect attempts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-bridge-attempt-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "wallet-bridge-password-long" });
  const origin = "http://127.0.0.1:8765";
  const server = createWalletBridgeServer({
    authorize: async () => null,
    origin,
    pairingCode: "87654321",
    sessionToken: "6".repeat(64),
    vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await request(`${base}/v1/pair`, origin, "", {
        body: JSON.stringify({ code: "00000000" }), method: "POST",
      });
      assert.equal(rejected.status, 400);
    }
    const locked = await request(`${base}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "87654321" }), method: "POST",
    });
    assert.equal(locked.status, 400);
    assert.match((await locked.json()).error, /unavailable/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});
