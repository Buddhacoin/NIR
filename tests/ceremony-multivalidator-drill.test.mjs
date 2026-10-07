import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  ATOMIC_UNITS, MIN_EVALUATOR_BOND, MIN_TRANSFER_FEE, PROTOCOL_VERSION, TREASURY_BPS,
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
import {
  certificateHistoryHead, createCertificateRecord, EMPTY_CERTIFICATE_RECORD_HASH,
  topologyHistoryCommitment,
} from "../blockchain/certificate-lifecycle.mjs";
import { certificateStorePaths, installCertificateRecord }
  from "../blockchain/certificate-lifecycle-store.mjs";
import { CERTIFICATE_MODE_LIFECYCLE, RuntimeCertificatePins }
  from "../blockchain/certificate-runtime.mjs";
import { peerRegistryHash } from "../blockchain/peer-registry.mjs";
import { createPeerRequest, verifyPeerResponse } from "../blockchain/peer-auth.mjs";
import { signReleaseManifest } from "../blockchain/release-manifest.mjs";
import {
  createReleaseAuthoritySet, createReleaseTransparencyAnchor,
} from "../blockchain/offline-release-governance.mjs";
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
    certificatePath, keyPath,
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
  const releaseAuthorities = Array.from({ length: 4 }, generateWallet);
  const protocolUpgradeReleaseAnchor = createReleaseTransparencyAnchor({
    initialSet: createReleaseAuthoritySet({
      authorities: releaseAuthorities.map((wallet, index) => ({
        ...publicWallet(wallet), operatorId: `release-${index}`,
      })), generation: 1, rotationDelayEntries: 2, threshold: 3,
    }),
    logId: "nir-protocol-releases",
    networkId: "nir-multivalidator-ceremony-drill",
  });
  const plan = createGenesisPlan({
    beaconAuthorities: publicRoles(beacons, "beacon", 19300),
    ceremonyOperators: ceremonyOperators.map((wallet, index) => ({
      ...publicWallet(wallet), contribution: digest(`drill-contribution-${index}`),
      nonce: digest(`drill-nonce-${index}`), operatorId: `ceremony-${index}`,
    })),
    evaluators: publicRoles(evaluators, "evaluator", 19200),
    evaluatorBondAmount: MIN_EVALUATOR_BOND.toString(),
    genesisTimestamp: 0,
    networkId: "nir-multivalidator-ceremony-drill",
    protocolVersion: PROTOCOL_VERSION,
    protocolUpgradeReleaseAnchor,
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

async function startValidator(values, index, {
  anchorPath = null, certificatePath = null, keyPath = null,
  mode = "dev-genesis",
} = {}) {
  const environment = {
    ...process.env, NIR_CERTIFICATE_MODE: mode,
    NIR_TLS_KEY_PATH: keyPath ?? values.certificates[index].keyPath,
  };
  if (anchorPath === null) delete environment.NIR_CERTIFICATE_HEAD_ANCHOR_PATH;
  else environment.NIR_CERTIFICATE_HEAD_ANCHOR_PATH = anchorPath;
  if (certificatePath === null) delete environment.NIR_TLS_CERT_PATH;
  else environment.NIR_TLS_CERT_PATH = certificatePath;
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

async function authenticatedRequest(values, fromIndex, toIndex, path, payload,
  certificateFingerprint = values.certificates[toIndex].fingerprint) {
  const auth = createPeerRequest({
    body: payload, networkId: values.plan.networkId, path,
    wallet: values.transports[fromIndex],
  });
  const response = await requestJson(`${values.plan.validators.find(({ address }) =>
    address === values.validators[toIndex].address).endpoint}${path}`, {
    body: { auth, payload }, method: "POST",
    tlsCertificateSha256: certificateFingerprint,
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
    assert.equal(evidence.nativePenaltyAvailable, true);
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

test("four ceremony processes enforce lifecycle renewal, expiry, revocation, and anchored restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-ceremony-certificate-drill-"));
  const running = new Map();
  try {
    const values = await fixture(root);
    const chain = new NirChain(values.compiled.genesis);
    const target = values.validators.findIndex(({ address }) =>
      address === chain.expectedProposer(3, 0));
    const observer = (target + 1) % 4;
    const replacement = certificate(root, "replacement");
    const liveCertificatePath = join(root, "live-certificate.pem");
    const liveKeyPath = join(root, "live-key.pem");
    copyFileSync(values.certificates[target].certificatePath, liveCertificatePath);
    copyFileSync(values.certificates[target].keyPath, liveKeyPath);
    const context = {
      currentHeight: 0, minimumActivationDelay: 0,
      networkId: values.compiled.genesis.networkId,
      peerRegistryHash: peerRegistryHash(values.compiled.genesis.peerRegistry),
      topologyHistoryHash: topologyHistoryCommitment(),
      validators: values.compiled.genesis.validators,
    };
    const histories = [];
    const anchorPaths = values.targets.map((_, index) =>
      join(root, `external-certificate-head-${index}.json`));
    const start = (index) => startValidator(values, index, {
      anchorPath: anchorPaths[index],
      certificatePath: index === target ? liveCertificatePath : null,
      keyPath: index === target ? liveKeyPath : null,
      mode: CERTIFICATE_MODE_LIFECYCLE,
    });
    // A ceremony process must not start lifecycle mode from only its static genesis pin.
    await assert.rejects(() => start(0), /external certificate history anchor|ENOENT/);
    const appendRecord = (record) => {
      histories.push(record);
      for (let index = 0; index < 4; index += 1) {
        installCertificateRecord(join(values.targets[index], "certificates"), record, context);
        writeFileSync(anchorPaths[index], `${JSON.stringify({
          format: "nir-certificate-history-anchor-v1",
          headHash: certificateHistoryHead(histories, context),
          networkId: context.networkId, recordCount: histories.length, version: 1,
        })}\n`, { mode: 0o600 });
      }
    };
    for (let index = 0; index < 4; index += 1) {
      appendRecord(createCertificateRecord({
        activationHeight: 0,
        certificate: {
          serial: (0x10 + index).toString(16),
          sha256: values.certificates[index].fingerprint,
        },
        networkId: context.networkId, operation: "issue", overlapUntilHeight: 0,
        peerRegistryHash: context.peerRegistryHash,
        previousRecordHash: EMPTY_CERTIFICATE_RECORD_HASH, sequence: 0,
        topologyHistoryHash: context.topologyHistoryHash,
        validatorAddress: values.validators[index].address,
      }, values.validators.slice(0, 3)));
    }
    for (let index = 0; index < 4; index += 1) running.set(index, await start(index));
    for (let index = 0; index < 4; index += 1) {
      assert.equal((await health(values, index)).body.certificateMode, CERTIFICATE_MODE_LIFECYCLE);
    }
    const pins = (height) => new RuntimeCertificatePins(values.targets[observer],
      values.compiled.genesis, { mode: CERTIFICATE_MODE_LIFECYCLE,
        externalAnchorPath: anchorPaths[observer] }).pinsFor(values.validators[target].address, height);
    const activeFingerprint = () => values.certificates[target].fingerprint;
    let currentTargetFingerprint = activeFingerprint();
    const liveHealth = (fingerprint) => requestJson(`https://127.0.0.1:${values.ports[target]}/health`, {
      tlsCertificateSha256: fingerprint,
    });
    const waitForFingerprint = async (fingerprint) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          if ((await liveHealth(fingerprint)).status === 200) {
            currentTargetFingerprint = fingerprint;
            return;
          }
        } catch { /* The live context has not reloaded yet. */ }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw new Error("ceremony process did not reload its TLS certificate");
    };
    const waitForHeight = async (height, except = -1) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const heights = await Promise.all(values.ports.map(async (_, index) => {
          if (index === except) return height;
          const fingerprint = index === target
            ? currentTargetFingerprint : values.certificates[index].fingerprint;
          try { return (await requestJson(`https://127.0.0.1:${values.ports[index]}/health`, {
            tlsCertificateSha256: fingerprint,
          })).body.height; } catch { return -1; }
        }));
        if (heights.every((seen) => seen >= height)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`not all ceremony processes finalized height ${height}`);
    };
    const produce = async (height, submittedTransfer = null) => {
      const proposer = values.validators.findIndex(({ address }) =>
        address === chain.expectedProposer(height, 0));
      const transfer = submittedTransfer ?? createMultisigTransfer({
        amount: ATOMIC_UNITS.toString(), fee: MIN_TRANSFER_FEE.toString(),
        memberPublicKeys: values.guardians.map(({ publicKey }) => publicKey),
        networkId: context.networkId, nonce: height - 1,
        recipient: generateWallet().address,
        signerWallets: values.guardians.slice(0, 2), threshold: 2,
      });
      const proposerFingerprint = proposer === target
        ? currentTargetFingerprint : values.certificates[proposer].fingerprint;
      const url = `https://127.0.0.1:${values.ports[proposer]}`;
      const ingress = await requestJson(`${url}/v1/transactions`, {
        body: transfer, method: "POST", tlsCertificateSha256: proposerFingerprint,
      });
      assert.equal(ingress.status, 202, ingress.body.error);
      const result = await requestJson(`${url}/v1/blocks/produce`, {
        method: "POST", tlsCertificateSha256: proposerFingerprint,
      });
      assert.equal(result.status, 202, result.body.error);
      assert.equal(result.body.height, height);
      await waitForHeight(height, height === 4 ? target : -1);
      const range = await authenticatedRequest(values, (observer + 1) % 4, observer,
        "/v1/p2p/blocks/range", { fromHeight: height, limit: 1 });
      assert.equal(range.status, 200, range.body.error);
      const finalized = range.body.result.blocks[0];
      if (height === 4) {
        const delivered = await authenticatedRequest(values, observer, target,
          "/v1/p2p/blocks", finalized, currentTargetFingerprint);
        assert.equal(delivered.status, 200, delivered.body.error);
        await waitForHeight(height);
      }
      chain.appendBlock(finalized);
    };
    const issue = histories.find((record) =>
      record.validatorAddress === values.validators[target].address);
    appendRecord(createCertificateRecord({
      activationHeight: 1,
      certificate: { serial: "20", sha256: replacement.fingerprint },
      networkId: context.networkId, operation: "renew", overlapUntilHeight: 2,
      peerRegistryHash: context.peerRegistryHash,
      previousRecordHash: issue.recordHash, sequence: 1,
      topologyHistoryHash: context.topologyHistoryHash,
      validatorAddress: values.validators[target].address,
    }, values.validators.slice(0, 3)));
    await produce(1);
    assert.deepEqual(pins(1), [replacement.fingerprint, activeFingerprint()]);
    assert.equal((await liveHealth(activeFingerprint())).status, 200);
    copyFileSync(replacement.certificatePath, liveCertificatePath);
    copyFileSync(replacement.keyPath, liveKeyPath);
    running.get(target).child.kill("SIGHUP");
    await waitForFingerprint(replacement.fingerprint);
    await produce(2);
    assert.deepEqual(pins(2), [replacement.fingerprint, activeFingerprint()]);
    copyFileSync(values.certificates[target].certificatePath, liveCertificatePath);
    copyFileSync(values.certificates[target].keyPath, liveKeyPath);
    running.get(target).child.kill("SIGHUP");
    await waitForFingerprint(activeFingerprint());
    await produce(3);
    assert.deepEqual(pins(3), [replacement.fingerprint]);
    const fourthTransfer = createMultisigTransfer({
      amount: ATOMIC_UNITS.toString(), fee: MIN_TRANSFER_FEE.toString(),
      memberPublicKeys: values.guardians.map(({ publicKey }) => publicKey),
      networkId: context.networkId, nonce: 3,
      recipient: generateWallet().address,
      signerWallets: values.guardians.slice(0, 2), threshold: 2,
    });
    const gossipFromObserver = () => requestJson(
      `https://127.0.0.1:${values.ports[observer]}/v1/transactions`, {
        body: fourthTransfer, method: "POST",
        tlsCertificateSha256: values.certificates[observer].fingerprint,
      });
    assert.equal((await liveHealth(activeFingerprint())).body.mempoolSize, 0);
    const rejectedGossip = await gossipFromObserver();
    assert.equal(rejectedGossip.status, 202, rejectedGossip.body.error);
    assert.equal(rejectedGossip.body.gossipedPeers, 2,
      "a running validator must refuse the expired old-certificate peer");
    assert.equal((await liveHealth(activeFingerprint())).body.mempoolSize, 0);
    const path = "/v1/p2p/health";
    const payload = {};
    const auth = createPeerRequest({
      body: payload, networkId: context.networkId, path,
      wallet: values.transports[observer],
    });
    await assert.rejects(() => requestJson(
      `https://127.0.0.1:${values.ports[target]}${path}`, {
        body: { auth, payload }, method: "POST", tlsCertificateSha256Pins: pins(3),
      }), /certificate pin mismatch/);
    assert.equal((await liveHealth(activeFingerprint())).body.height, 3);
    copyFileSync(replacement.certificatePath, liveCertificatePath);
    copyFileSync(replacement.keyPath, liveKeyPath);
    running.get(target).child.kill("SIGHUP");
    await waitForFingerprint(replacement.fingerprint);
    const accepted = await requestJson(`https://127.0.0.1:${values.ports[target]}${path}`, {
      body: { auth, payload }, method: "POST", tlsCertificateSha256Pins: pins(3),
    });
    assert.equal(accepted.status, 200, accepted.body.error);
    verifyPeerResponse({
      auth: accepted.body.auth, networkId: context.networkId,
      requestNonce: auth.nonce, result: accepted.body.result,
      trustedPeer: publicWallet(values.transports[target]),
    });
    const acceptedGossip = await gossipFromObserver();
    assert.equal(acceptedGossip.status, 202, acceptedGossip.body.error);
    assert.equal(acceptedGossip.body.gossipedPeers, 3);
    assert.equal((await liveHealth(replacement.fingerprint)).body.mempoolSize, 1);
    const beforeRevoke = certificateStorePaths(join(values.targets[target], "certificates"));
    const oldPrimary = readFileSync(beforeRevoke.primary);
    const oldBackup = readFileSync(beforeRevoke.backup);
    appendRecord(createCertificateRecord({
      activationHeight: 4, certificate: null,
      networkId: context.networkId, operation: "revoke", overlapUntilHeight: 4,
      peerRegistryHash: context.peerRegistryHash,
      previousRecordHash: histories.at(-1).recordHash, sequence: 2,
      topologyHistoryHash: context.topologyHistoryHash,
      validatorAddress: values.validators[target].address,
    }, values.validators.slice(0, 3)));
    await produce(4, fourthTransfer);
    assert.throws(() => pins(4), /no active lifecycle/);
    await running.get(target).stop();
    running.delete(target);
    await assert.rejects(() => start(target), /no active lifecycle/);
    // Rolling back both locally signed copies is still rejected by the off-node head.
    writeFileSync(beforeRevoke.primary, oldPrimary);
    writeFileSync(beforeRevoke.backup, oldBackup);
    await assert.rejects(() => start(target), /external anchor|below or conflicts/);
  } finally {
    await Promise.all([...running.values()].map((instance) => instance.stop()));
    rmSync(root, { recursive: true, force: true });
  }
});
