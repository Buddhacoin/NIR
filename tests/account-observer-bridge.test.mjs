import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createAccountObserverBridgeServer } from "../blockchain/account-observer-bridge.mjs";
import { createAccountProof } from "../blockchain/account-proof.mjs";
import { finalizeBlock, NirChain } from "../blockchain/chain.mjs";
import { CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION,
  EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS,
  SAFETY_POLICY_V1_COMMITMENT } from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createFinalityProof } from "../blockchain/light-client.mjs";

test("observer requires a pinned address, network and genesis checkpoint", () => {
  assert.throws(() => createAccountObserverBridgeServer({}), /configuration/);
  assert.throws(() => createAccountObserverBridgeServer({
    address: `nir1${"a".repeat(64)}`,
    nodeBaseUrl: "http://example.com:9000",
    origin: "moz-extension://9eeb5c1f-8628-4c41-98ce-1fd5a654091d",
    sessionToken: "b".repeat(64),
    trustAnchor: { expectedNetworkId: "nir-test", trustedValidators: [],
      genesisCheckpoint: { height: 0, tipHash: "a".repeat(64),
        stateRoot: "a".repeat(64), accountStateRoot: "a".repeat(64),
        validatorSetId: "a".repeat(64) } },
  }), /configuration/);
});

test("observer verifies only one Firefox account on one pinned chain and cannot sign", async () => {
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const members = validators.map((entry, index) => ({
    ...publicWallet(entry), operatorId: `validator-${index}`,
  }));
  const account = generateWallet();
  const other = generateWallet();
  const networkId = "nir-observer-test";
  const genesisConfig = {
    beaconAuthorities: beacons.map((entry, index) => ({
      ...publicWallet(entry), operatorId: `beacon-${index}`,
    })),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluators: evaluators.map((entry, index) => ({
      ...publicWallet(entry), operatorId: `evaluator-${index}`,
    })),
    genesisTimestamp: 0, networkId,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: other.address, validators: members,
  };
  const chain = new NirChain(genesisConfig);
  const genesis = chain.blocks()[0];
  const block = finalizeBlock(chain.buildBlock({ timestamp: 1 }), validators.slice(0, 3));
  chain.appendBlock(block);
  const proofFor = (address) => {
    const state = chain.accountStateProof(address);
    return createAccountProof({ account: state.account,
      accountStateRoot: state.accountStateRoot, inclusionProof: state.inclusionProof,
      height: chain.height, networkId, stateRoot: chain.stateRoot, tipHash: chain.tipHash,
      validators: members, validatorWallets: validators.slice(0, 3) });
  };
  const origin = "moz-extension://9eeb5c1f-8628-4c41-98ce-1fd5a654091d";
  const token = "a".repeat(64);
  let nodeAccountProof = proofFor(account.address);
  let nodeFinalityProofs = [createFinalityProof(block)];
  let nodeHealthNetworkId = networkId;
  const node = createServer((request, response) => {
    const payload = request.url === "/health"
      ? { height: chain.height, networkId: nodeHealthNetworkId, tipHash: chain.tipHash }
      : request.url === "/v1/finality-proofs?fromHeight=0&limit=512"
        ? { proofs: nodeFinalityProofs }
        : request.url === `/v1/accounts/${account.address}/proof`
          ? nodeAccountProof : null;
    response.writeHead(payload ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(payload ?? { error: "not found" }));
  });
  await new Promise((resolve) => node.listen(0, "127.0.0.1", resolve));
  const trustAnchor = { expectedNetworkId: networkId,
    genesisCheckpoint: { accountStateRoot: genesis.accountStateRoot,
      height: 0, stateRoot: genesis.stateRoot, tipHash: genesis.hash,
      validatorSetId: chain.validatorSetId },
    handoffs: [], trustedValidators: members };
  const server = createAccountObserverBridgeServer({
    address: account.address, origin, sessionToken: token, trustAnchor,
    nodeBaseUrl: `http://127.0.0.1:${node.address().port}`,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body, overrides = {}) => fetch(`${base}${path}`, {
      body: JSON.stringify(body), method: "POST", headers: {
        "content-type": "application/json", origin,
        "x-nir-observer-token": token, ...overrides,
      },
    });
    const accountProof = proofFor(account.address);
    assert.equal((await post("/v1/verify-account-proof", { proof: accountProof })).status, 400);
    assert.equal((await post("/v1/verify-finality-chain", {
      proofs: [createFinalityProof(block)],
    }, { "x-nir-observer-token": "b".repeat(64) })).status, 401);
    assert.equal((await post("/v1/verify-finality-chain", {
      proofs: [createFinalityProof(block)],
    }, { origin: "moz-extension://46d1a996-3b60-4cea-8b12-a544bff7e999" })).status, 403);
    const finality = await post("/v1/verify-finality-chain", {
      proofs: [createFinalityProof(block)],
    });
    assert.equal(finality.status, 200);
    assert.equal((await finality.json()).genesisHash, genesis.hash);
    const verified = await post("/v1/verify-account-proof", { proof: accountProof });
    assert.equal(verified.status, 200);
    const result = await verified.json();
    assert.equal(result.address, account.address);
    assert.equal(result.statement.account.atomicBalance, "0");
    assert.equal(result.verified, true);
    const refreshed = await post("/v1/refresh-account", {});
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json()).statement.account.address, account.address);
    nodeAccountProof = proofFor(other.address);
    assert.equal((await post("/v1/refresh-account", {})).status, 400);
    nodeAccountProof = proofFor(account.address);
    nodeHealthNetworkId = "nir-foreign-network";
    assert.equal((await post("/v1/refresh-account", {})).status, 400);
    nodeHealthNetworkId = networkId;
    nodeFinalityProofs = [{ ...nodeFinalityProofs[0], hash: "f".repeat(64) }];
    assert.equal((await post("/v1/refresh-account", {})).status, 400);
    nodeFinalityProofs = [createFinalityProof(block)];
    assert.equal((await post("/v1/refresh-account", { address: other.address })).status, 400);
    assert.equal((await post("/v1/verify-account-proof", {
      proof: proofFor(other.address),
    })).status, 400);
    assert.equal((await post("/v1/verify-account-proof", {
      proof: { ...accountProof, account: { ...accountProof.account, atomicBalance: "50" } },
    })).status, 400);
    assert.equal((await post("/v1/verify-account-proof", {
      proof: { ...accountProof, networkId: "nir-other-network" },
    })).status, 400);
    const fork = new NirChain(genesisConfig);
    const forkOne = finalizeBlock(fork.buildBlock({ timestamp: 2 }), validators.slice(0, 3));
    fork.appendBlock(forkOne);
    const forkTwo = finalizeBlock(fork.buildBlock({ timestamp: 3 }), validators.slice(0, 3));
    fork.appendBlock(forkTwo);
    assert.notEqual(forkOne.hash, block.hash);
    assert.equal((await post("/v1/verify-finality-chain", {
      proofs: [createFinalityProof(forkOne), createFinalityProof(forkTwo)],
    })).status, 400);
    // A rejected higher fork must not replace the previously verified tip.
    assert.equal((await post("/v1/verify-account-proof", { proof: accountProof })).status, 200);
    for (const path of ["/v1/sign-transfer", "/v1/wallet", "/v1/pair", "/v1/select-account"]) {
      assert.equal((await post(path, {})).status, 404);
    }
    assert.equal((await fetch(`${base}/v1/verify-account-proof`, { method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-nir-observer-token" } })).status, 204);
    const wrongGenesis = createAccountObserverBridgeServer({
      address: account.address, origin, sessionToken: token,
      trustAnchor: { ...trustAnchor, genesisCheckpoint: {
        ...trustAnchor.genesisCheckpoint, tipHash: "f".repeat(64),
      } },
    });
    await new Promise((resolve) => wrongGenesis.listen(0, "127.0.0.1", resolve));
    try {
      assert.equal((await fetch(`http://127.0.0.1:${wrongGenesis.address().port}/v1/verify-finality-chain`, {
        body: JSON.stringify({ proofs: [createFinalityProof(block)] }), method: "POST",
        headers: { "content-type": "application/json", origin,
          "x-nir-observer-token": token },
      })).status, 400);
    } finally {
      await new Promise((resolve) => { wrongGenesis.closeAllConnections?.(); wrongGenesis.close(resolve); });
    }
  } finally {
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    await new Promise((resolve) => { node.closeAllConnections?.(); node.close(resolve); });
  }
});

test("observer rejects a signed continuous v28 header with a foreign genesis identity", async () => {
  const validators = Array.from({ length: 4 }, generateWallet);
  const members = validators.map((entry, index) => ({
    ...publicWallet(entry), operatorId: `validator-${index}`,
  }));
  const membersFor = (role) => Array.from({ length: 4 }, (_, index) => ({
    ...publicWallet(generateWallet()), operatorId: `${role}-${index}`,
  }));
  const networkId = "nir-observer-identity";
  const chain = new NirChain({
    beaconAuthorities: membersFor("beacon"),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluationEnvironment: { adapter_protocol: "nir-application-adapter-v1",
      cpu_limit: 2, format: "nir-evaluation-environment-v1",
      image_digest: `sha256:${"3".repeat(64)}`, memory_limit_bytes: 1 << 30,
      runner_digest: `sha256:${"4".repeat(64)}`, timeout_seconds: 60 },
    evaluators: membersFor("evaluator"),
    genesisProtocolVersion: EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
    genesisTimestamp: 0, networkId,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: generateWallet().address, validators: members,
  });
  const genesis = chain.blocks()[0];
  const activationHeight = 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  const append = (options = {}) => {
    const block = finalizeBlock(chain.buildBlock({ timestamp: chain.height + 1,
      ...options }), validators.slice(0, 3));
    chain.appendBlock(block);
  };
  append({ protocolUpgrade: { activationHeight, format: "nir-protocol-upgrade-v1",
    version: CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION } });
  while (chain.height < activationHeight) append();
  const foreign = finalizeBlock({ ...chain.buildBlock({ timestamp: chain.height + 1 }),
    chainIdentityGenesisHash: "f".repeat(64) }, validators.slice(0, 3));
  const origin = "moz-extension://9eeb5c1f-8628-4c41-98ce-1fd5a654091d";
  const token = "a".repeat(64);
  const server = createAccountObserverBridgeServer({
    address: generateWallet().address, origin, sessionToken: token,
    trustAnchor: { expectedNetworkId: networkId,
      genesisCheckpoint: { accountStateRoot: genesis.accountStateRoot, height: 0,
        protocolVersion: EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
        stateRoot: genesis.stateRoot, tipHash: genesis.hash,
        validatorSetId: chain.validatorSetId },
      handoffs: [], trustedValidators: members },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/verify-finality-chain`, {
      method: "POST", body: JSON.stringify({ proofs: [
        ...chain.blocks().slice(1).map(createFinalityProof), createFinalityProof(foreign),
      ] }), headers: { "content-type": "application/json", origin,
        "x-nir-observer-token": token },
    });
    assert.equal(response.status, 400);
  } finally {
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  }
});
