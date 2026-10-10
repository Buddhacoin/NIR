import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const checkpointDirectory = mkdtempSync(join(tmpdir(), "nir-account-observer-"));
  const checkpointPath = join(checkpointDirectory, "checkpoint.json");
  let nodeAccountProof = proofFor(account.address);
  let nodeFinalityProofs = [createFinalityProof(block)];
  let nodeHealthNetworkId = networkId;
  let nodeHealthHeight = null;
  let nodeHealthTipHash = null;
  const node = createServer((request, response) => {
    const url = new URL(request.url, "http://node.local");
    const fromHeight = Number(url.searchParams.get("fromHeight"));
    const limit = Number(url.searchParams.get("limit"));
    const payload = request.url === "/health"
      ? { height: nodeHealthHeight ?? chain.height, networkId: nodeHealthNetworkId,
        tipHash: nodeHealthTipHash ?? chain.tipHash }
      : url.pathname === "/v1/finality-proofs" && Number.isInteger(fromHeight) &&
        Number.isInteger(limit)
        ? { proofs: nodeFinalityProofs.slice(fromHeight, fromHeight + limit) }
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
    address: account.address, checkpointPath, origin, sessionToken: token, trustAnchor,
    nodeBaseUrl: `http://127.0.0.1:${node.address().port}`,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let serverClosed = false;
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
    nodeHealthHeight = 513;
    assert.equal((await post("/v1/refresh-account", {})).status, 400);
    nodeHealthHeight = null;
    nodeFinalityProofs = [{ ...nodeFinalityProofs[0], hash: "f".repeat(64) }];
    // The already authenticated tip needs no duplicate finality download.
    assert.equal((await post("/v1/refresh-account", {})).status, 200);
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
    const second = finalizeBlock(chain.buildBlock({ timestamp: 2 }), validators.slice(0, 3));
    chain.appendBlock(second);
    nodeFinalityProofs = [createFinalityProof(block), createFinalityProof(second)];
    nodeAccountProof = proofFor(account.address);
    assert.equal((await post("/v1/refresh-account", {})).status, 200);
    assert.throws(() => createAccountObserverBridgeServer({
      address: account.address, checkpointPath, origin, sessionToken: token, trustAnchor,
      nodeBaseUrl: `http://127.0.0.1:${node.address().port}`,
    }), /EEXIST/);
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
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    serverClosed = true;
    const restarted = createAccountObserverBridgeServer({
      address: account.address, checkpointPath, origin, sessionToken: token, trustAnchor,
      nodeBaseUrl: `http://127.0.0.1:${node.address().port}`,
    });
    await new Promise((resolve) => restarted.listen(0, "127.0.0.1", resolve));
    try {
      nodeHealthHeight = 1;
      nodeHealthTipHash = block.hash;
      nodeFinalityProofs = [createFinalityProof(block)];
      nodeAccountProof = accountProof;
      const stale = await fetch(`http://127.0.0.1:${restarted.address().port}/v1/refresh-account`, {
        body: "{}", method: "POST", headers: {
          "content-type": "application/json", origin, "x-nir-observer-token": token,
        },
      });
      assert.equal(stale.status, 400);
    } finally {
      await new Promise((resolve) => {
        restarted.closeAllConnections?.(); restarted.close(resolve);
      });
    }
    nodeHealthHeight = null;
    nodeHealthTipHash = null;
    for (let height = chain.height + 1; height <= 513; height += 1) {
      chain.appendBlock(finalizeBlock(chain.buildBlock({ timestamp: height }),
        validators.slice(0, 3)));
    }
    nodeFinalityProofs = chain.blocks().slice(1).map(createFinalityProof);
    nodeAccountProof = proofFor(account.address);
    const lastProof = nodeFinalityProofs[512];
    nodeFinalityProofs[512] = { ...lastProof, hash: "f".repeat(64) };
    const interruptedPath = join(checkpointDirectory, "interrupted.json");
    const startInterrupted = () => createAccountObserverBridgeServer({
      address: account.address, checkpointPath: interruptedPath,
      origin, sessionToken: token, trustAnchor,
      nodeBaseUrl: `http://127.0.0.1:${node.address().port}`,
    });
    const interrupted = startInterrupted();
    await new Promise((resolve) => interrupted.listen(0, "127.0.0.1", resolve));
    try {
      const rejected = await fetch(`http://127.0.0.1:${interrupted.address().port}/v1/refresh-account`, {
        body: "{}", method: "POST", headers: {
          "content-type": "application/json", origin, "x-nir-observer-token": token,
        },
      });
      assert.equal(rejected.status, 400);
    } finally {
      await new Promise((resolve) => {
        interrupted.closeAllConnections?.(); interrupted.close(resolve);
      });
    }
    nodeFinalityProofs[512] = lastProof;
    const resumed = startInterrupted();
    await new Promise((resolve) => resumed.listen(0, "127.0.0.1", resolve));
    try {
      const recovered = await fetch(`http://127.0.0.1:${resumed.address().port}/v1/refresh-account`, {
        body: "{}", method: "POST", headers: {
          "content-type": "application/json", origin, "x-nir-observer-token": token,
        },
      });
      assert.equal(recovered.status, 200);
      assert.equal((await recovered.json()).statement.height, 513);
    } finally {
      await new Promise((resolve) => {
        resumed.closeAllConnections?.(); resumed.close(resolve);
      });
    }
    const freshObserver = createAccountObserverBridgeServer({
      address: account.address, checkpointPath: join(checkpointDirectory, "fresh.json"),
      origin, sessionToken: token, trustAnchor,
      nodeBaseUrl: `http://127.0.0.1:${node.address().port}`,
    });
    await new Promise((resolve) => freshObserver.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(
        `http://127.0.0.1:${freshObserver.address().port}/v1/refresh-account`, {
          body: "{}", method: "POST", headers: {
            "content-type": "application/json", origin, "x-nir-observer-token": token,
          },
        });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).statement.height, 513);
    } finally {
      await new Promise((resolve) => {
        freshObserver.closeAllConnections?.(); freshObserver.close(resolve);
      });
    }
  } finally {
    if (!serverClosed) {
      await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    }
    await new Promise((resolve) => { node.closeAllConnections?.(); node.close(resolve); });
    rmSync(checkpointDirectory, { recursive: true, force: true });
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
    const post = (proofs) => fetch(
      `http://127.0.0.1:${server.address().port}/v1/verify-finality-chain`, {
        method: "POST", body: JSON.stringify({ proofs }), headers: {
          "content-type": "application/json", origin, "x-nir-observer-token": token,
        },
      });
    const beforeActivation = chain.blocks().slice(1, -1).map(createFinalityProof);
    assert.equal((await post(beforeActivation)).status, 200);
    const response = await post([
      createFinalityProof(chain.blocks().at(-1)), createFinalityProof(foreign),
    ]);
    assert.equal(response.status, 400);
  } finally {
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  }
});
