import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  ATOMIC_UNITS, MIN_TRANSFER_FEE, PROTOCOL_VERSION, TREASURY_BPS,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import {
  blockHash, createMultisigTransfer, multisigAddress, NirChain, voteForBlock,
} from "../blockchain/chain.mjs";
import { generateWallet, hashObject, publicWallet } from "../blockchain/crypto.mjs";
import { initializeValidatorFromCeremony } from "../blockchain/ceremony-validator-init.mjs";
import {
  compileGenesis, createGenesisApprovalEnvelope, createGenesisPlan, signGenesisPlan,
  signGenesisPeerRegistry,
} from "../blockchain/genesis-ceremony.mjs";
import {
  assembleCeremonyRegistryAnchor, signCeremonyRegistryAnchor,
} from "../blockchain/genesis-ceremony-anchor.mjs";
import { requestJson } from "../blockchain/http-client.mjs";
import { createPeerRequest, verifyPeerResponse } from "../blockchain/peer-auth.mjs";
import { signReleaseManifest } from "../blockchain/release-manifest.mjs";
import { encryptWallet } from "../blockchain/vault.mjs";
import {
  proveValidatorPrepareEquivocation,
  verifyValidatorPrepareEquivocationEvidence,
} from "../blockchain/validator-equivocation.mjs";

function digest(value) { return createHash("sha256").update(value).digest("hex"); }

async function reservePorts(count) {
  const servers = Array.from({ length: count }, () => createServer());
  await Promise.all(servers.map((server) => new Promise((resolve) =>
    server.listen(0, "127.0.0.1", resolve))));
  const ports = servers.map((server) => server.address().port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

function certificate(directory, index) {
  const keyPath = join(directory, `validator-${index}-tls-key.pem`);
  const certificatePath = join(directory, `validator-${index}-tls-certificate.pem`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", `/CN=validator-${index}.example`, "-keyout", keyPath, "-out", certificatePath,
  ], { stdio: "ignore" });
  const pem = readFileSync(certificatePath);
  return {
    fingerprint: new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase(),
    keyPath,
    pem,
  };
}

function publicRoles(wallets, prefix, port) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet), endpoint: `http://127.0.0.1:${port + index}`,
    operatorId: `${prefix}-${index}`,
  }));
}

function signedRelease(releaseSigner, label = "ceremony-network-drill") {
  const payload = {
    files: [{ executable: false, path: "package.json", sha3_256: digest(`${label}-package`), size: 7 }],
    format: "nir-source-release-v1",
    releaseVersion: "0.2.0",
    sourceRevision: digest(`${label}-revision`),
  };
  return signReleaseManifest({
    ...payload, manifestHash: hashObject(payload, "RELEASE_MANIFEST_HASH"),
  }, releaseSigner);
}

async function fixture(root) {
  const ports = await reservePorts(4);
  const certificates = Array.from({ length: 4 }, (_, index) => certificate(root, index));
  const validators = Array.from({ length: 4 }, generateWallet);
  const transports = Array.from({ length: 4 }, generateWallet);
  const ceremonyOperators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const guardians = Array.from({ length: 3 }, generateWallet);
  const releaseSigner = generateWallet();
  const release = signedRelease(releaseSigner);
  const releaseOptions = { signedRelease: release, trustedAddress: releaseSigner.address };
  const plan = createGenesisPlan({
    beaconAuthorities: publicRoles(beacons, "beacon", 19300),
    ceremonyOperators: ceremonyOperators.map((wallet, index) => ({
      ...publicWallet(wallet), contribution: digest(`drill-contribution-${index}`),
      nonce: digest(`drill-nonce-${index}`), operatorId: `ceremony-${index}`,
    })),
    evaluators: publicRoles(evaluators, "evaluator", 19200),
    genesisTimestamp: 0,
    networkId: "nir-multivalidator-ceremony-drill",
    protocolVersion: PROTOCOL_VERSION,
    sourceReleaseManifestHash: release.manifest.manifestHash,
    treasury: {
      address: multisigAddress(guardians.map(({ publicKey }) => publicKey), 2),
      algorithm: "ml-dsa-65-multisig",
      memberPublicKeys: guardians.map(({ publicKey }) => publicKey),
      threshold: 2,
      vestingPolicy: {
        allocationBps: Number(TREASURY_BPS), durationMs: TREASURY_VESTING_MS,
        model: "linear-from-genesis",
      },
    },
    validators: validators.map((wallet, index) => ({
      ...publicWallet(wallet), endpoint: `https://127.0.0.1:${ports[index]}`,
      operatorId: `validator-${index}`,
      tlsCertificateSha256: certificates[index].fingerprint,
      transport: publicWallet(transports[index]),
    })),
  }, releaseOptions);
  const envelope = createGenesisApprovalEnvelope(
    plan,
    ceremonyOperators.slice(0, 3).map((wallet) => signGenesisPlan(plan, wallet, releaseOptions)),
    validators.slice(0, 3).map((wallet) => signGenesisPeerRegistry(plan, wallet, releaseOptions)),
    releaseOptions,
  );
  const compiled = compileGenesis(plan, envelope, releaseOptions);
  const anchorPayload = {
    count: 1, latestGenesisHash: compiled.genesisHash,
    latestPlanCommitment: plan.commitment, registryHead: digest("drill-registry-head"),
    releaseManifestHash: release.manifest.manifestHash,
  };
  const anchor = assembleCeremonyRegistryAnchor(
    anchorPayload, plan,
    ceremonyOperators.slice(0, 3).map((wallet) =>
      signCeremonyRegistryAnchor(anchorPayload, plan, wallet, releaseOptions)),
    releaseOptions,
  );
  const passwords = validators.map((_, index) => ({
    transport: `transport-drill-password-${index}`,
    validator: `validator-drill-password-${index}`,
  }));
  const targets = validators.map((wallet, index) => {
    const target = join(root, `operator-${index}`);
    initializeValidatorFromCeremony(target, {
      anchor, envelope, genesis: compiled.genesis, plan, signedRelease: release,
      tlsCertificatePem: certificates[index].pem,
      transportPassword: passwords[index].transport,
      transportVault: encryptWallet(transports[index], passwords[index].transport),
      trustedAddress: releaseSigner.address,
      validatorPassword: passwords[index].validator,
      validatorVault: encryptWallet(wallet, passwords[index].validator),
    });
    return target;
  });
  return {
    anchor, certificates, compiled, envelope, guardians, passwords, plan, ports,
    release, releaseSigner, targets, transports, validators,
  };
}

async function startValidator(values, index) {
  const environment = {
    ...process.env, NIR_TLS_KEY_PATH: values.certificates[index].keyPath,
  };
  const child = spawn(process.execPath, [
    "blockchain/network-cli.mjs", "serve-validator", values.targets[index],
    String(values.ports[index]), values.releaseSigner.address,
  ], {
    cwd: new URL("..", import.meta.url), env: environment,
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  child.stdio[3].end(`${values.passwords[index].validator}\n`);
  child.stdio[4].end(`${values.passwords[index].transport}\n`);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`validator ${index} timeout: ${stderr}`)), 10_000);
    const poll = setInterval(() => {
      if (stdout.includes(" listening on ")) {
        clearTimeout(deadline); clearInterval(poll); resolve();
      } else if (child.exitCode !== null) {
        clearTimeout(deadline); clearInterval(poll);
        reject(new Error(`validator ${index} exited: ${stderr}`));
      }
    }, 10);
  });
  return {
    child, environment,
    logs: () => `${stdout}\n${stderr}`,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

async function authenticatedRequest(values, fromIndex, toIndex, path, payload) {
  const auth = createPeerRequest({
    body: payload, networkId: values.plan.networkId, path,
    wallet: values.transports[fromIndex],
  });
  const response = await requestJson(`${values.plan.validators.find(({ address }) =>
    address === values.validators[toIndex].address).endpoint}${path}`, {
    body: { auth, payload }, method: "POST",
    tlsCertificateSha256: values.certificates[toIndex].fingerprint,
  });
  if (response.ok) {
    const trusted = publicWallet(values.transports[toIndex]);
    verifyPeerResponse({
      auth: response.body.auth, networkId: values.plan.networkId,
      requestNonce: auth.nonce, result: response.body.result, trustedPeer: trusted,
    });
  }
  return response;
}

async function health(values, index) {
  return requestJson(`https://127.0.0.1:${values.ports[index]}/health`, {
    tlsCertificateSha256: values.certificates[index].fingerprint,
  });
}

function finalizedBlock(proposal, prepares, commits) {
  return {
    ...proposal,
    certificate: [...commits].sort((a, b) => a.validator.localeCompare(b.validator)),
    hash: blockHash(proposal),
    prepareCertificate: [...prepares]
      .sort((a, b) => a.validator.localeCompare(b.validator)),
  };
}

function scanDirectory(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? scanDirectory(path) : [readFileSync(path).toString("utf8")];
  }).join("\n");
}

test("four ceremony validators finalize, restart, and catch up without a coordinator", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-ceremony-network-drill-"));
  const running = new Map();
  const launched = [];
  try {
    const values = await fixture(root);
    const launch = async (index) => {
      const instance = await startValidator(values, index);
      launched.push(instance);
      return instance;
    };

    const mismatchedGenesis = structuredClone(values.compiled.genesis);
    mismatchedGenesis.networkId += "-wrong";
    assert.throws(() => initializeValidatorFromCeremony(join(root, "wrong-genesis"), {
      anchor: values.anchor, envelope: values.envelope, genesis: mismatchedGenesis,
      plan: values.plan, signedRelease: values.release,
      tlsCertificatePem: values.certificates[0].pem,
      transportPassword: values.passwords[0].transport,
      transportVault: encryptWallet(values.transports[0], values.passwords[0].transport),
      trustedAddress: values.releaseSigner.address,
      validatorPassword: values.passwords[0].validator,
      validatorVault: encryptWallet(values.validators[0], values.passwords[0].validator),
    }), /compiled genesis/);
    const otherRelease = signedRelease(values.releaseSigner, "other-release");
    assert.throws(() => initializeValidatorFromCeremony(join(root, "wrong-release"), {
      anchor: values.anchor, envelope: values.envelope, genesis: values.compiled.genesis,
      plan: values.plan, signedRelease: otherRelease,
      tlsCertificatePem: values.certificates[0].pem,
      transportPassword: values.passwords[0].transport,
      transportVault: encryptWallet(values.transports[0], values.passwords[0].transport),
      trustedAddress: values.releaseSigner.address,
      validatorPassword: values.passwords[0].validator,
      validatorVault: encryptWallet(values.validators[0], values.passwords[0].validator),
    }), /does not match/);

    for (let index = 0; index < 4; index += 1) {
      running.set(index, await launch(index));
      assert.equal(existsSync(join(values.targets[index], "VALIDATOR-KEY.json")), false);
      assert.equal(existsSync(join(values.targets[index], "TRANSPORT-KEY.json")), false);
      assert.equal(existsSync(join(values.targets[index], "AUTHORIZED-COORDINATOR.json")), false);
    }

    const recipient = generateWallet();
    const first = createMultisigTransfer({
      amount: ATOMIC_UNITS.toString(), fee: MIN_TRANSFER_FEE.toString(),
      memberPublicKeys: values.guardians.map(({ publicKey }) => publicKey),
      networkId: values.plan.networkId, nonce: 0, recipient: recipient.address,
      signerWallets: values.guardians.slice(0, 2), threshold: 2,
    });
    const ingress = await requestJson(`https://127.0.0.1:${values.ports[0]}/v1/transactions`, {
      body: first, method: "POST", tlsCertificateSha256: values.certificates[0].fingerprint,
    });
    assert.equal(ingress.status, 202, ingress.body.error);
    assert.equal(ingress.body.gossipedPeers, 3);

    const chain = new NirChain(values.compiled.genesis);
    const firstProposer = chain.expectedProposer(1, 0);
    const firstProposerIndex = values.validators.findIndex(({ address }) => address === firstProposer);
    const produced = await requestJson(
      `https://127.0.0.1:${values.ports[firstProposerIndex]}/v1/blocks/produce`, {
        method: "POST", tlsCertificateSha256: values.certificates[firstProposerIndex].fingerprint,
      },
    );
    assert.equal(produced.status, 202, produced.body.error);
    assert.ok(produced.body.prepares >= 3);
    assert.ok(produced.body.commits >= 3);
    assert.equal(produced.body.height, 1);
    for (let index = 0; index < 4; index += 1) {
      assert.equal((await health(values, index)).body.height, 1);
    }

    const range = await authenticatedRequest(values, 0, 1, "/v1/p2p/blocks/range", {
      fromHeight: 1, limit: 1,
    });
    assert.equal(range.status, 200);
    const finalized = range.body.result.blocks[0];
    assert.ok(finalized.prepareCertificate.length >= 3);
    assert.ok(finalized.certificate.length >= 3);
    chain.appendBlock(finalized);

    const foreign = generateWallet();
    const foreignPayload = {};
    const foreignPath = "/v1/p2p/health";
    const foreignAuth = createPeerRequest({
      body: foreignPayload, networkId: values.plan.networkId,
      path: foreignPath, wallet: foreign,
    });
    const foreignResponse = await requestJson(
      `https://127.0.0.1:${values.ports[0]}${foreignPath}`, {
        body: { auth: foreignAuth, payload: foreignPayload }, method: "POST",
        tlsCertificateSha256: values.certificates[0].fingerprint,
      },
    );
    assert.equal(foreignResponse.status, 400);
    assert.match(foreignResponse.body.error, /authenticated transport binding/);

    const replayProposal = chain.buildBlock({ timestamp: Date.now() });
    const replayedCertificate = {
      ...replayProposal,
      certificate: finalized.certificate,
      hash: blockHash(replayProposal),
      prepareCertificate: finalized.prepareCertificate,
    };
    const replay = await authenticatedRequest(
      values, 0, 1, "/v1/p2p/blocks", replayedCertificate,
    );
    assert.equal(replay.status, 400);
    assert.match(replay.body.error, /certificate|signature|prepare/i);

    const { certificate: _certificate, hash: _hash, prepareCertificate: _prepare, ...stale } = finalized;
    const staleProposerIndex = values.validators.findIndex(
      ({ address }) => address === stale.proposer,
    );
    const staleRound = await authenticatedRequest(
      values, staleProposerIndex, 1, "/v1/p2p/proposals", stale,
    );
    assert.equal(staleRound.status, 400);
    assert.match(staleRound.body.error, /height|extend|stale|action/i);

    const secondProposer = chain.expectedProposer(2, 0);
    const secondProposerIndex = values.validators.findIndex(({ address }) => address === secondProposer);
    const offlineIndex = (secondProposerIndex + 1) % 4;
    await running.get(offlineIndex).stop();
    running.delete(offlineIndex);
    const second = createMultisigTransfer({
      amount: ATOMIC_UNITS.toString(), fee: MIN_TRANSFER_FEE.toString(),
      memberPublicKeys: values.guardians.map(({ publicKey }) => publicKey),
      networkId: values.plan.networkId, nonce: 1, recipient: recipient.address,
      signerWallets: values.guardians.slice(0, 2), threshold: 2,
    });
    const secondIngress = await requestJson(
      `https://127.0.0.1:${values.ports[secondProposerIndex]}/v1/transactions`, {
        body: second, method: "POST",
        tlsCertificateSha256: values.certificates[secondProposerIndex].fingerprint,
      },
    );
    assert.equal(secondIngress.status, 202, secondIngress.body.error);
    const secondProduced = await requestJson(
      `https://127.0.0.1:${values.ports[secondProposerIndex]}/v1/blocks/produce`, {
        method: "POST",
        tlsCertificateSha256: values.certificates[secondProposerIndex].fingerprint,
      },
    );
    assert.equal(secondProduced.status, 202, secondProduced.body.error);
    assert.equal(secondProduced.body.height, 2);
    assert.ok(secondProduced.body.prepares >= 3 && secondProduced.body.commits >= 3);

    running.set(offlineIndex, await launch(offlineIndex));
    const synchronized = await requestJson(
      `https://127.0.0.1:${values.ports[offlineIndex]}/v1/sync`, {
        method: "POST", tlsCertificateSha256: values.certificates[offlineIndex].fingerprint,
      },
    );
    assert.equal(synchronized.status, 200, synchronized.body.error);
    assert.equal(synchronized.body.height, 2);
    const finalHealth = await health(values, secondProposerIndex);
    const caughtUp = await health(values, offlineIndex);
    assert.equal(caughtUp.body.tipHash, finalHealth.body.tipHash);

    await running.get(offlineIndex).stop();
    running.delete(offlineIndex);
    running.set(offlineIndex, await launch(offlineIndex));
    const restarted = await health(values, offlineIndex);
    assert.equal(restarted.body.height, 2);
    assert.equal(restarted.body.tipHash, finalHealth.body.tipHash);

    const secondRange = await authenticatedRequest(values, 0, 1, "/v1/p2p/blocks/range", {
      fromHeight: 2, limit: 1,
    });
    assert.equal(secondRange.status, 200);
    const secondBlock = secondRange.body.result.blocks[0];
    chain.appendBlock(secondBlock);

    // Partition consensus delivery into two groups after the proposal is known.
    // Delayed, duplicated, and reordered authenticated deliveries cannot create a quorum
    // inside either 2-node side.
    const partitionTransfer = createMultisigTransfer({
      amount: ATOMIC_UNITS.toString(), fee: MIN_TRANSFER_FEE.toString(),
      memberPublicKeys: values.guardians.map(({ publicKey }) => publicKey),
      networkId: values.plan.networkId, nonce: 2, recipient: generateWallet().address,
      signerWallets: values.guardians.slice(0, 2), threshold: 2,
    });
    const partitionProposal = chain.buildBlock({
      timestamp: Date.now(), transactions: [partitionTransfer],
    });
    const partitionProposer = values.validators.findIndex(
      ({ address }) => address === partitionProposal.proposer,
    );
    const deliveryOrder = [2, 0, 3, 1];
    const partitionVotes = new Map();
    for (const target of deliveryOrder) {
      await new Promise((resolve) => setTimeout(resolve, target % 2 === 0 ? 15 : 5));
      const response = await authenticatedRequest(
        values, partitionProposer, target, "/v1/p2p/proposals", partitionProposal,
      );
      assert.equal(response.status, 200, response.body.error);
      partitionVotes.set(target, response.body.result.vote);
    }
    const duplicate = await authenticatedRequest(
      values, partitionProposer, 0, "/v1/p2p/proposals", partitionProposal,
    );
    assert.equal(duplicate.status, 200, duplicate.body.error);
    assert.deepEqual(duplicate.body.result.vote, partitionVotes.get(0));

    for (const group of [[0, 1], [2, 3]]) {
      const insufficient = await authenticatedRequest(
        values, partitionProposer, group[0], "/v1/p2p/commits", {
          prepareCertificate: group.map((index) => partitionVotes.get(index)),
          proposal: partitionProposal,
        },
      );
      assert.equal(insufficient.status, 400);
      assert.match(insufficient.body.error, /quorum/);
    }
    for (let index = 0; index < 4; index += 1) {
      assert.equal((await health(values, index)).body.height, 2);
    }

    // Healing permits exactly the already-locked value to collect quorum and finalize.
    const healedPrepares = [0, 1, 2].map((index) => partitionVotes.get(index));
    const healedCommits = [];
    for (let target = 0; target < 4; target += 1) {
      const response = await authenticatedRequest(
        values, partitionProposer, target, "/v1/p2p/commits", {
          prepareCertificate: healedPrepares, proposal: partitionProposal,
        },
      );
      assert.equal(response.status, 200, response.body.error);
      healedCommits.push(response.body.result.vote);
    }
    const partitionFinalized = finalizedBlock(
      partitionProposal, healedPrepares, healedCommits.slice(0, 3),
    );
    for (let target = 0; target < 4; target += 1) {
      const response = await authenticatedRequest(
        values, partitionProposer, target, "/v1/p2p/blocks", partitionFinalized,
      );
      assert.equal(response.status, 200, response.body.error);
    }
    chain.appendBlock(partitionFinalized);

    // At the next height a Byzantine proposer sends one valid value to a 3-node
    // partition and a conflicting valid value to the isolated validator.
    const recipientA = generateWallet();
    const recipientB = generateWallet();
    const transferA = createMultisigTransfer({
      amount: ATOMIC_UNITS.toString(), fee: MIN_TRANSFER_FEE.toString(),
      memberPublicKeys: values.guardians.map(({ publicKey }) => publicKey),
      networkId: values.plan.networkId, nonce: 3, recipient: recipientA.address,
      signerWallets: values.guardians.slice(0, 2), threshold: 2,
    });
    const transferB = createMultisigTransfer({
      amount: (ATOMIC_UNITS + 1n).toString(), fee: MIN_TRANSFER_FEE.toString(),
      memberPublicKeys: values.guardians.map(({ publicKey }) => publicKey),
      networkId: values.plan.networkId, nonce: 3, recipient: recipientB.address,
      signerWallets: values.guardians.slice(0, 2), threshold: 2,
    });
    const proposalA = chain.buildBlock({ timestamp: Date.now(), transactions: [transferA] });
    const proposalB = chain.buildBlock({ timestamp: Date.now() + 1, transactions: [transferB] });
    assert.notEqual(blockHash(proposalA), blockHash(proposalB));
    const byzantine = values.validators.findIndex(({ address }) =>
      address === proposalA.proposer);
    assert.equal(proposalB.proposer, proposalA.proposer);
    const isolated = (byzantine + 1) % 4;
    const majority = [0, 1, 2, 3].filter((index) => index !== isolated);
    const majorityVotes = new Map();
    for (const target of [majority[2], majority[0], majority[1]]) {
      const response = await authenticatedRequest(
        values, byzantine, target, "/v1/p2p/proposals", proposalA,
      );
      assert.equal(response.status, 200, response.body.error);
      majorityVotes.set(target, response.body.result.vote);
    }
    const isolatedResponse = await authenticatedRequest(
      values, byzantine, isolated, "/v1/p2p/proposals", proposalB,
    );
    assert.equal(isolatedResponse.status, 200, isolatedResponse.body.error);
    const byzantineVoteA = majorityVotes.get(byzantine);
    const byzantineVoteB = voteForBlock(proposalB, values.validators[byzantine]);
    const evidence = proveValidatorPrepareEquivocation({
      chain,
      first: { proposal: proposalA, vote: byzantineVoteA },
      second: { proposal: proposalB, vote: byzantineVoteB },
    });
    assert.equal(evidence.validator, values.validators[byzantine].address);
    assert.equal(evidence.nativePenaltyAvailable, false);
    assert.deepEqual(
      verifyValidatorPrepareEquivocationEvidence(evidence, { chain }), evidence,
    );
    assert.throws(() => proveValidatorPrepareEquivocation({
      chain,
      first: { proposal: proposalA, vote: byzantineVoteA },
      second: { proposal: proposalB, vote: { ...byzantineVoteB, signature: "forged" } },
    }), /signatures/);
    const malformed = { ...proposalB, unexpected: true };
    assert.throws(() => proveValidatorPrepareEquivocation({
      chain,
      first: { proposal: proposalA, vote: byzantineVoteA },
      second: {
        proposal: malformed,
        vote: voteForBlock(malformed, values.validators[byzantine]),
      },
    }), /malformed or invalid/);

    const minorityCommit = await authenticatedRequest(
      values, byzantine, isolated, "/v1/p2p/commits", {
        prepareCertificate: [isolatedResponse.body.result.vote, byzantineVoteB],
        proposal: proposalB,
      },
    );
    assert.equal(minorityCommit.status, 400);
    assert.match(minorityCommit.body.error, /quorum/);

    const majorityPrepares = majority.map((index) => majorityVotes.get(index));
    const majorityCommits = [];
    for (const target of majority) {
      const response = await authenticatedRequest(
        values, byzantine, target, "/v1/p2p/commits", {
          prepareCertificate: majorityPrepares, proposal: proposalA,
        },
      );
      assert.equal(response.status, 200, response.body.error);
      majorityCommits.push(response.body.result.vote);
    }
    const majorityFinalized = finalizedBlock(proposalA, majorityPrepares, majorityCommits);
    for (const target of majority) {
      const response = await authenticatedRequest(
        values, byzantine, target, "/v1/p2p/blocks", majorityFinalized,
      );
      assert.equal(response.status, 200, response.body.error);
    }
    const majorityTip = (await health(values, majority[0])).body.tipHash;
    for (const target of majority) {
      const status = await health(values, target);
      assert.equal(status.body.height, 4);
      assert.equal(status.body.tipHash, majorityTip);
    }
    assert.equal((await health(values, isolated)).body.height, 3);

    // Healing plus restart uses authenticated block-range catch-up. The durable
    // conflicting prepare cannot produce or preserve a conflicting finalized tip.
    await running.get(isolated).stop();
    running.delete(isolated);
    running.set(isolated, await launch(isolated));
    const restoredMinorityVote = await authenticatedRequest(
      values, byzantine, isolated, "/v1/p2p/proposals", proposalB,
    );
    assert.equal(restoredMinorityVote.status, 200, restoredMinorityVote.body.error);
    assert.deepEqual(
      restoredMinorityVote.body.result.vote, isolatedResponse.body.result.vote,
    );
    const conflictingAfterRestart = await authenticatedRequest(
      values, byzantine, isolated, "/v1/p2p/proposals", proposalA,
    );
    assert.equal(conflictingAfterRestart.status, 400);
    assert.match(conflictingAfterRestart.body.error, /refuses to equivocate/);
    const healed = await requestJson(
      `https://127.0.0.1:${values.ports[isolated]}/v1/sync`, {
        method: "POST", tlsCertificateSha256: values.certificates[isolated].fingerprint,
      },
    );
    assert.equal(healed.status, 200, healed.body.error);
    assert.equal(healed.body.height, 4);
    assert.equal((await health(values, isolated)).body.tipHash, majorityTip);

    for (let index = 0; index < 4; index += 1) {
      const generation = join(dirname(values.targets[index]), readlinkSync(values.targets[index]));
      const contents = scanDirectory(generation);
      assert.equal(contents.includes("privateKey"), false);
      assert.equal(contents.includes(values.validators[index].privateKey), false);
      assert.equal(contents.includes(values.transports[index].privateKey), false);
      assert.equal(contents.includes(values.passwords[index].validator), false);
      assert.equal(contents.includes(values.passwords[index].transport), false);
    }
    const forbidden = [
      ...values.passwords.flatMap(({ transport, validator }) => [transport, validator]),
      ...values.transports.map(({ privateKey }) => privateKey),
      ...values.validators.map(({ privateKey }) => privateKey),
    ];
    for (const instance of launched) {
      const surfaces = [
        JSON.stringify(instance.child.spawnargs), JSON.stringify(instance.environment),
        instance.logs(),
      ];
      for (const secret of forbidden) {
        assert.ok(surfaces.every((surface) => !surface.includes(secret)));
      }
    }
  } finally {
    await Promise.all(launched.map((instance) => instance.stop()));
    rmSync(root, { recursive: true, force: true });
  }
});
