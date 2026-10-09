import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTransfer, finalizeBlock, NirChain, multisigAddress } from "../blockchain/chain.mjs";
import {
  MIN_EVALUATOR_BOND, MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS,
  PROTOCOL_VERSION,
  FOUNDER_ALLOCATION, FOUNDER_BPS, PROTOCOL_TREASURY_ALLOCATION,
  PROTOCOL_TREASURY_BPS, MINING_POOL, FOUNDER_IMMEDIATE_BPS,
  TESTER_REWARD_RESERVE_BPS,
  TREASURY_BPS,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { canonicalJson, generateWallet, hashObject, publicWallet, signObject, verifyObject } from "../blockchain/crypto.mjs";
import { certificateHistoryHead, createCertificateRecord,
  EMPTY_CERTIFICATE_RECORD_HASH, topologyHistoryCommitment }
  from "../blockchain/certificate-lifecycle.mjs";
import { installCertificateRecord } from "../blockchain/certificate-lifecycle-store.mjs";
import { runtimeCertificateContext } from "../blockchain/certificate-runtime.mjs";
import { assembleCheckpointTrustPackage, createCheckpointWitnessAttestation,
  createCheckpointWitnessPolicy } from "../blockchain/checkpoint-trust-package.mjs";
import { assembleCheckpointTrustPackageV2, createCheckpointWitnessAttestationV2 }
  from "../blockchain/checkpoint-trust-package-v2.mjs";
import { createPeerAnnouncement, verifyPeerAnnouncement } from "../blockchain/peer-discovery.mjs";
import { peerRegistryHash } from "../blockchain/peer-registry.mjs";
import { createFinalityProof, verifyFinalityProofChain } from "../blockchain/light-client.mjs";
import { signReleaseManifest } from "../blockchain/release-manifest.mjs";
import {
  createReleaseAuthoritySet, createReleaseTransparencyAnchor,
} from "../blockchain/offline-release-governance.mjs";
import {
  compileGenesis,
  createGenesisApprovalEnvelope,
  createGenesisPlan,
  signGenesisPlan,
  signGenesisPeerRegistry,
  verifyGenesisCeremony,
  verifyGenesisPlan,
} from "../blockchain/genesis-ceremony.mjs";
import {
  assembleCeremonyRegistryAnchor,
  createCeremonyRegistryAnchorPayload,
  signCeremonyRegistryAnchor,
  verifyCeremonyRegistryAnchor,
} from "../blockchain/genesis-ceremony-anchor.mjs";
import {
  appendCeremonyRegistry,
  ceremonyRegistryPaths,
  repairCeremonyRegistryOneCopy,
  verifyCeremonyRegistry,
} from "../blockchain/genesis-ceremony-store.mjs";
import { verifyCeremonyBoundTransactionIngressConfig }
  from "../blockchain/validator-transaction-ingress-ceremony.mjs";
import { certificateSha256 } from "../blockchain/http-client.mjs";
import { createValidatorLiveIdentity } from "../blockchain/validator-live-identity.mjs";

function digest(label) {
  return createHash("sha256").update(label).digest("hex");
}

function role(wallets, prefix, port) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet),
    endpoint: `http://127.0.0.1:${port + index}`,
    operatorId: `${prefix}-${index}`,
  }));
}

function validatorRole(wallets, transports, port) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet),
    endpoint: `http://127.0.0.1:${port + index}`,
    operatorId: `validator-${index}`,
    tlsCertificateSha256: null,
    transport: publicWallet(transports[index]),
  }));
}

function fixture(label = "primary", {
  releaseSigner = generateWallet(), releaseVersion = "0.2.0",
} = {}) {
  const validators = Array.from({ length: 4 }, generateWallet);
  const validatorTransports = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const operators = Array.from({ length: 4 }, generateWallet);
  const guardians = Array.from({ length: 3 }, generateWallet);
  const memberPublicKeys = guardians.map(({ publicKey }) => publicKey);
  const releasePayload = {
    files: [{
      executable: false,
      path: "package.json",
      sha3_256: digest(`${label}-package-json`),
      size: 32,
    }],
    format: "nir-source-release-v1",
    releaseVersion,
    sourceRevision: digest(`${label}-revision`),
  };
  const releaseManifest = {
    ...releasePayload,
    manifestHash: hashObject(releasePayload, "RELEASE_MANIFEST_HASH"),
  };
  const signedRelease = signReleaseManifest(releaseManifest, releaseSigner);
  const networkId = `nir-${label}-valueless-devnet`;
  const releaseAuthorities = Array.from({ length: 4 }, generateWallet);
  const protocolUpgradeReleaseAnchor = createReleaseTransparencyAnchor({
    initialSet: createReleaseAuthoritySet({
      authorities: releaseAuthorities.map((wallet, index) => ({
        ...publicWallet(wallet), operatorId: `release-${index}`,
      })),
      generation: 1, rotationDelayEntries: 2, threshold: 3,
    }),
    logId: "nir-protocol-releases",
    networkId,
  });
  const input = {
    beaconAuthorities: role(beacons, "beacon", 9300),
    ceremonyOperators: operators.map((wallet, index) => ({
      ...publicWallet(wallet),
      contribution: digest(`${label}-contribution-${index}`),
      nonce: digest(`${label}-nonce-${index}`),
      operatorId: `ceremony-${index}`,
    })),
    evaluators: role(evaluators, "evaluator", 9200),
    evaluatorBondAmount: MIN_EVALUATOR_BOND.toString(),
    genesisTimestamp: 0,
    networkId,
    protocolVersion: PROTOCOL_VERSION,
    protocolUpgradeReleaseAnchor,
    sourceReleaseManifestHash: releaseManifest.manifestHash,
    treasury: {
      address: multisigAddress(memberPublicKeys, 2),
      algorithm: "ml-dsa-65-multisig",
      memberPublicKeys,
      threshold: 2,
      vestingPolicy: {
        allocationBps: Number(TREASURY_BPS),
        durationMs: TREASURY_VESTING_MS,
        model: "linear-from-genesis",
      },
    },
    validators: validatorRole(validators, validatorTransports, 9100),
  };
  return {
    input,
    operators,
    releaseOptions: { signedRelease, trustedAddress: releaseSigner.address },
    releaseSigner,
    validatorTransports,
    validators,
  };
}

function approved(values, count = 3) {
  const plan = createGenesisPlan(values.input, values.releaseOptions);
  const approvals = values.operators.slice(0, count)
    .map((wallet) => signGenesisPlan(plan, wallet, values.releaseOptions));
  const registryApprovals = values.validators.slice(0, count)
    .map((wallet) => signGenesisPeerRegistry(plan, wallet, values.releaseOptions));
  return {
    approvals,
    envelope: createGenesisApprovalEnvelope(
      plan, approvals, registryApprovals, values.releaseOptions,
    ),
    plan,
    registryApprovals,
  };
}

const evaluationEnvironment = {
  adapter_protocol: "nir-application-adapter-v1",
  cpu_limit: 2,
  format: "nir-evaluation-environment-v1",
  image_digest: `sha256:${digest("ceremony-v2-image")}`,
  memory_limit_bytes: 1 << 30,
  runner_digest: `sha256:${digest("ceremony-v2-runner")}`,
  timeout_seconds: 60,
};

function v2Fixture(label = "v2") {
  const values = fixture(label);
  values.input.format = "nir-public-genesis-plan-v2";
  values.input.evaluationEnvironment = structuredClone(evaluationEnvironment);
  return values;
}

function v3Fixture(label = "v3") {
  const values = v2Fixture(label);
  const founderMembers = Array.from({ length: 3 }, generateWallet)
    .map(({ publicKey }) => publicKey);
  values.input.format = "nir-public-genesis-plan-v3";
  values.input.treasury.vestingPolicy.allocationBps = Number(PROTOCOL_TREASURY_BPS);
  values.input.founder = {
    address: multisigAddress(founderMembers, 2),
    algorithm: "ml-dsa-65-multisig",
    memberPublicKeys: founderMembers,
    threshold: 2,
    vestingPolicy: {
      allocationBps: Number(FOUNDER_BPS),
      durationMs: TREASURY_VESTING_MS,
      model: "linear-from-genesis",
    },
  };
  return values;
}

function v4Fixture(label = "v4") {
  const values = v3Fixture(label);
  values.input.format = "nir-public-genesis-plan-v4";
  values.input.founder.vestingPolicy = {
    ...values.input.founder.vestingPolicy,
    immediateBps: Number(FOUNDER_IMMEDIATE_BPS),
    model: "genesis-release-plus-linear",
  };
  return values;
}

function v5Fixture(label = "v5") {
  const values = v4Fixture(label);
  values.input.format = "nir-public-genesis-plan-v5";
  values.input.treasury.vestingPolicy = {
    ...values.input.treasury.vestingPolicy,
    immediateBps: Number(TESTER_REWARD_RESERVE_BPS),
    model: "genesis-release-plus-linear",
  };
  return values;
}

test("v5 ceremony commits tester reserve without rewriting v4", () => {
  const values = v5Fixture("tester-reward-reserve");
  const { plan, envelope } = approved(values);
  assert.equal(envelope.format, "nir-public-genesis-approvals-v5");
  const compiled = compileGenesis(plan, envelope, values.releaseOptions);
  assert.equal(compiled.genesis.treasuryImmediateBps, Number(TESTER_REWARD_RESERVE_BPS));
  assert.equal(new NirChain(compiled.genesis).blocks()[0].hash, compiled.genesisHash);
  assert.throws(() => verifyGenesisCeremony(plan, {
    ...envelope, format: "nir-public-genesis-approvals-v4",
  }, values.releaseOptions), /envelope/);
  const wrong = structuredClone(values.input);
  wrong.treasury.vestingPolicy.immediateBps = 20;
  assert.throws(() => createGenesisPlan(wrong, values.releaseOptions), /treasury/);
  const old = v4Fixture("unchanged-v4");
  assert.equal(approved(old).plan.treasury.vestingPolicy.model, "linear-from-genesis");
});

test("v4 ceremony commits one-percent founder release without rewriting v3", () => {
  const values = v4Fixture("founder-genesis-release");
  const { plan, envelope } = approved(values);
  assert.equal(envelope.format, "nir-public-genesis-approvals-v4");
  const compiled = compileGenesis(plan, envelope, values.releaseOptions);
  assert.equal(compiled.genesis.founderImmediateBps, Number(FOUNDER_IMMEDIATE_BPS));
  assert.equal(new NirChain(compiled.genesis).blocks()[0].hash, compiled.genesisHash);
  assert.throws(() => verifyGenesisCeremony(plan, {
    ...envelope, format: "nir-public-genesis-approvals-v3",
  }, values.releaseOptions), /envelope/);
  const wrong = structuredClone(values.input);
  wrong.founder.vestingPolicy.immediateBps = 200;
  assert.throws(() => createGenesisPlan(wrong, values.releaseOptions), /founder/);
  const old = v3Fixture("unchanged-v3");
  assert.equal(approved(old).plan.founder.vestingPolicy.model, "linear-from-genesis");
});

test("v3 ceremony binds separate founder and protocol multisig allocations", () => {
  const values = v3Fixture("split-allocation");
  const { plan, envelope } = approved(values);
  assert.equal(plan.format, "nir-public-genesis-plan-v3");
  assert.equal(envelope.format, "nir-public-genesis-approvals-v3");
  const compiled = compileGenesis(plan, envelope, values.releaseOptions);
  assert.equal(compiled.genesis.founderAddress, plan.founder.address);
  const chain = new NirChain(compiled.genesis);
  assert.equal(chain.blocks()[0].hash, compiled.genesisHash);
  assert.equal(chain.balance(plan.founder.address), FOUNDER_ALLOCATION);
  assert.equal(chain.balance(plan.treasury.address),
    PROTOCOL_TREASURY_ALLOCATION - MIN_EVALUATOR_BOND * 4n);
  assert.equal(FOUNDER_ALLOCATION + PROTOCOL_TREASURY_ALLOCATION + MINING_POOL,
    21_000_000n * 100_000_000n);

  const forged = structuredClone(values.input);
  forged.founder = structuredClone(forged.treasury);
  forged.founder.vestingPolicy.allocationBps = Number(FOUNDER_BPS);
  assert.throws(() => createGenesisPlan(forged, values.releaseOptions), /distinct/);
  const wrongBps = structuredClone(values.input);
  wrongBps.founder.vestingPolicy.allocationBps = Number(TREASURY_BPS);
  assert.throws(() => createGenesisPlan(wrongBps, values.releaseOptions), /founder/);
});

test("frozen pre-v2 public ceremony artifacts retain their v1 hashes", () => {
  const vector = JSON.parse(readFileSync(new URL("./vectors/genesis-ceremony-v1.json",
    import.meta.url), "utf8"));
  const options = { signedRelease: vector.signedRelease,
    trustedAddress: vector.trustedAddress };
  assert.equal(verifyGenesisPlan(vector.plan, options).commitment, vector.planCommitment);
  assert.equal(verifyGenesisCeremony(vector.plan, vector.envelope, options).verified, true);
  assert.equal(compileGenesis(vector.plan, vector.envelope, options).genesisHash,
    vector.genesisHash);
});

test("v2 ceremony commits the exact evaluation environment and keeps v1 unchanged", () => {
  const legacy = fixture("legacy-vector");
  const v1 = approved(legacy);
  const oldPayload = { ...v1.plan };
  delete oldPayload.commitment;
  assert.equal(v1.plan.format, "nir-public-genesis-plan-v1");
  assert.equal(v1.plan.commitment, hashObject(oldPayload, "PUBLIC_GENESIS_CEREMONY_V1"));
  assert.equal(v1.envelope.format, "nir-public-genesis-approvals-v1");
  assert.equal(verifyObject({ commitment: v1.plan.commitment, format: v1.plan.format,
    networkId: v1.plan.networkId }, v1.approvals[0].signature,
  legacy.operators[0].publicKey, "PUBLIC_GENESIS_APPROVAL_V1"), true);
  const oldGenesis = compileGenesis(v1.plan, v1.envelope, legacy.releaseOptions);
  assert.equal(Object.hasOwn(oldGenesis.genesis, "evaluationEnvironment"), false);
  assert.equal(new NirChain(oldGenesis.genesis).blocks()[0].hash, oldGenesis.genesisHash);
  assert.throws(() => verifyGenesisPlan({ ...v1.plan,
    evaluationEnvironment }, legacy.releaseOptions), /schema/);

  const values = v2Fixture();
  const { plan, envelope, approvals } = approved(values);
  assert.equal(plan.format, "nir-public-genesis-plan-v2");
  assert.equal(envelope.format, "nir-public-genesis-approvals-v2");
  assert.equal(envelope.peerRegistryApprovals[0].registrySignature !== undefined, true);
  assert.deepEqual(plan.evaluationEnvironment, evaluationEnvironment);
  assert.equal(verifyGenesisCeremony(plan, envelope, values.releaseOptions).verified, true);
  const compiled = compileGenesis(plan, envelope, values.releaseOptions);
  assert.deepEqual(compiled.genesis.evaluationEnvironment, evaluationEnvironment);
  assert.equal(new NirChain(compiled.genesis).blocks()[0].hash, compiled.genesisHash);

  const changed = structuredClone(plan);
  changed.evaluationEnvironment.cpu_limit += 1;
  assert.throws(() => verifyGenesisCeremony(changed, envelope, values.releaseOptions), /commitment/);
  const malformed = structuredClone(values.input);
  malformed.evaluationEnvironment.extra = true;
  assert.throws(() => createGenesisPlan(malformed, values.releaseOptions), /environment/);
  const missing = structuredClone(values.input);
  delete missing.evaluationEnvironment;
  assert.throws(() => createGenesisPlan(missing, values.releaseOptions), /schema|environment/);
  const mixed = { ...envelope, format: "nir-public-genesis-approvals-v1" };
  assert.throws(() => verifyGenesisCeremony(plan, mixed, values.releaseOptions), /envelope/);
  const v1RegistryApproval = signObject({
    activationHeight: 0, epoch: 0, networkId: plan.networkId,
    peers: compiled.genesis.peerRegistry.peers,
    previousRegistryHash: compiled.genesis.peerRegistry.previousRegistryHash,
  }, values.validators[0], "PEER_REGISTRY_APPROVAL");
  const reusedRegistry = structuredClone(envelope);
  reusedRegistry.peerRegistryApprovals[0] = {
    validator: values.validators[0].address, signature: v1RegistryApproval,
  };
  assert.throws(() => verifyGenesisCeremony(plan, reusedRegistry, values.releaseOptions),
    /schema|peer-registry approval/);
  const wrongDomainRegistry = structuredClone(envelope);
  wrongDomainRegistry.peerRegistryApprovals[0].signature = v1RegistryApproval;
  assert.throws(() => verifyGenesisCeremony(plan, wrongDomainRegistry,
    values.releaseOptions), /peer-registry approval/);
  const forged = { ...envelope, approvals: approvals.map((approval) => ({ ...approval })) };
  forged.approvals[0].signature = signObject({ commitment: plan.commitment,
    format: plan.format, networkId: plan.networkId }, values.operators[0],
  "PUBLIC_GENESIS_APPROVAL_V1");
  assert.throws(() => verifyGenesisCeremony(plan, forged, values.releaseOptions), /approval/);
});

test("mixed v1/v2 registry verifies without reinterpreting prior plans", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-ceremony-v2-registry-"));
  try {
    const releaseSigner = generateWallet();
    const oldValues = fixture("legacy-registry", { releaseSigner, releaseVersion: "0.2.0" });
    const newValues = v2Fixture("new-registry");
    // Both records must be checked against the same independently pinned release signer.
    const signedRelease = signReleaseManifest(newValues.releaseOptions.signedRelease.manifest,
      releaseSigner);
    newValues.releaseOptions = { signedRelease, trustedAddress: releaseSigner.address };
    const old = approved(oldValues);
    const next = approved(newValues);
    const directory = join(root, "registry");
    appendCeremonyRegistry(directory, old.plan, old.envelope, oldValues.releaseOptions);
    appendCeremonyRegistry(directory, next.plan, next.envelope, newValues.releaseOptions);
    const verified = verifyCeremonyRegistry(directory, { trustedAddress: releaseSigner.address });
    assert.equal(verified.count, 2);
    assert.equal(verified.records[0].plan.format, "nir-public-genesis-plan-v1");
    assert.equal(verified.records[1].plan.format, "nir-public-genesis-plan-v2");
    const reused = v2Fixture("reused-registry");
    reused.input.ceremonyOperators[0].contribution = old.plan.ceremonyOperators[0].contribution;
    const replay = approved(reused);
    assert.throws(() => verifyGenesisCeremony(replay.plan, replay.envelope, {
      ...reused.releaseOptions, priorPlans: [old.plan, next.plan],
    }), /contribution/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("v2 compiled genesis can activate sequential protocol v24 through v28", () => {
  const values = v2Fixture("v2-upgrade");
  const { plan, envelope } = approved(values);
  assert.equal(verifyGenesisCeremony(plan, envelope, values.releaseOptions).verified, true);
  const compiled = compileGenesis(plan, envelope, values.releaseOptions);
  const independentlyPinnedGenesisHash = compiled.genesisHash;
  const chain = new NirChain(compiled.genesis);
  const genesisBlock = chain.blocks()[0];
  const proofs = [];
  for (let version = 25; version <= 28; version += 1) {
    const activationHeight = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
    const proposal = chain.buildBlock({
      timestamp: chain.blocks().at(-1).timestamp + 1,
      protocolUpgrade: { activationHeight, format: "nir-protocol-upgrade-v1", version },
    });
    chain.appendBlock(finalizeBlock(proposal, values.validators.slice(0, 3)));
    proofs.push(createFinalityProof(chain.blocks().at(-1)));
    while (chain.height < activationHeight) {
      const block = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1 });
      chain.appendBlock(finalizeBlock(block, values.validators.slice(0, 3)));
      proofs.push(createFinalityProof(chain.blocks().at(-1)));
    }
    assert.equal(chain.protocolVersion, version);
  }
  const proofOptions = {
    checkpoint: { height: 0, protocolVersion: PROTOCOL_VERSION,
      stateRoot: genesisBlock.stateRoot, tipHash: genesisBlock.hash },
    expectedChainIdentityGenesisHash: independentlyPinnedGenesisHash,
    expectedNetworkId: plan.networkId,
    protocolUpgradeReleaseAnchor: plan.protocolUpgradeReleaseAnchor,
    trustedValidators: compiled.genesis.validators,
  };
  assert.equal(verifyFinalityProofChain(proofs, proofOptions).tipHash, chain.tipHash);

  const foreignInput = structuredClone(values.input);
  foreignInput.evaluationEnvironment.runner_digest = `sha256:${digest("foreign-runner")}`;
  const foreignPlan = createGenesisPlan(foreignInput, values.releaseOptions);
  const foreignApprovals = values.operators.slice(0, 3)
    .map((wallet) => signGenesisPlan(foreignPlan, wallet, values.releaseOptions));
  const replayedRegistryEnvelope = createGenesisApprovalEnvelope(foreignPlan,
    foreignApprovals, envelope.peerRegistryApprovals, values.releaseOptions);
  assert.throws(() => verifyGenesisCeremony(foreignPlan, replayedRegistryEnvelope,
    values.releaseOptions), /peer-registry approval/);
  const foreignRegistryApprovals = values.validators.slice(0, 3)
    .map((wallet) => signGenesisPeerRegistry(foreignPlan, wallet, values.releaseOptions));
  const foreignEnvelope = createGenesisApprovalEnvelope(foreignPlan, foreignApprovals,
    foreignRegistryApprovals, values.releaseOptions);
  assert.equal(verifyGenesisCeremony(foreignPlan, foreignEnvelope,
    values.releaseOptions).verified, true);
  const foreignGenesis = compileGenesis(foreignPlan, foreignEnvelope,
    values.releaseOptions);
  assert.notEqual(foreignGenesis.genesisHash, independentlyPinnedGenesisHash);
  const foreign = new NirChain(foreignGenesis.genesis);
  const foreignBlock = finalizeBlock(foreign.buildBlock({ timestamp: 1 }),
    values.validators.slice(0, 3));
  foreign.appendBlock(foreignBlock);
  assert.throws(() => verifyFinalityProofChain([createFinalityProof(foreignBlock)], {
    ...proofOptions, checkpoint: { ...proofOptions.checkpoint,
      stateRoot: foreign.blocks()[0].stateRoot, tipHash: foreignGenesis.genesisHash },
  }), /pinned genesis identity/);
});

test("ceremony-bound ingress startup derives its upstream only from an anchored v2 registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-ceremony-bound-ingress-"));
  let upstream;
  try {
    const values = v2Fixture("ingress-startup");
    const keyPath = join(root, "validator-key.pem");
    const certPath = join(root, "validator-cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost"],
    { stdio: "ignore" });
    const key = readFileSync(keyPath);
    const cert = readFileSync(certPath);
    const tlsCertificateSha256 = certificateSha256(new X509Certificate(cert).raw);
    let genesisHash;
    let wrongSigner = false;
    let challengePosts = 0;
    let transactionPosts = 0;
    const foreignWallet = generateWallet();
    upstream = createHttpsServer({ key, cert }, async (request, response) => {
      if (request.url === "/v1/transactions") {
        transactionPosts += 1;
        request.resume(); response.writeHead(500); response.end(); return;
      }
      challengePosts += 1;
      let encoded = "";
      for await (const chunk of request) encoded += chunk;
      const { nonce } = JSON.parse(encoded);
      const attestation = createValidatorLiveIdentity({
        chainIdentityGenesisHash: genesisHash, height: 0, networkId: values.input.networkId,
        nonce, tipHash: genesisHash, tlsCertificateSha256,
        wallet: wrongSigner ? foreignWallet : values.validators[0],
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(attestation));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamOrigin = `https://127.0.0.1:${upstream.address().port}`;
    values.input.validators[0].endpoint = upstreamOrigin;
    values.input.validators[0].tlsCertificateSha256 = tlsCertificateSha256;
    const { plan, envelope } = approved(values);
    const registryDirectory = join(root, "registry");
    appendCeremonyRegistry(registryDirectory, plan, envelope, values.releaseOptions);
    const state = verifyCeremonyRegistry(registryDirectory,
      { trustedAddress: values.releaseOptions.trustedAddress });
    const payload = createCeremonyRegistryAnchorPayload(state);
    const approvals = values.operators.slice(0, 3).map((wallet) =>
      signCeremonyRegistryAnchor(payload, plan, wallet, values.releaseOptions));
    const anchor = assembleCeremonyRegistryAnchor(payload, plan, approvals,
      values.releaseOptions);
    genesisHash = compileGenesis(plan, envelope, values.releaseOptions).genesisHash;
    const options = { anchor, expectedGenesisHash: genesisHash,
      expectedNetworkId: plan.networkId, expectedTlsCertificateSha256: tlsCertificateSha256,
      expectedUpstreamOrigin: upstreamOrigin, registryDirectory,
      trustedReleaseSignerAddress: values.releaseOptions.trustedAddress,
      validatorAddress: values.validators[0].address, walletOrigin: null };
    assert.deepEqual(verifyCeremonyBoundTransactionIngressConfig(options), {
      expectedNetworkId: plan.networkId, tlsCertificateSha256,
      upstreamOrigin, walletOrigin: null,
    });
    const anchorPath = join(root, "external-anchor.json");
    writeFileSync(anchorPath, JSON.stringify(anchor));
    const compiled = compileGenesis(plan, envelope, values.releaseOptions);
    const chain = new NirChain(compiled.genesis);
    for (let version = 25; version <= 28; version += 1) {
      const activationHeight = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
      const proposal = chain.buildBlock({
        timestamp: chain.blocks().at(-1).timestamp + 1,
        protocolUpgrade: { activationHeight, format: "nir-protocol-upgrade-v1", version },
      });
      chain.appendBlock(finalizeBlock(proposal, values.validators.slice(0, 3)));
      while (chain.height < activationHeight) {
        chain.appendBlock(finalizeBlock(chain.buildBlock({
          timestamp: chain.blocks().at(-1).timestamp + 1,
        }), values.validators.slice(0, 3)));
      }
    }
    const proof = createFinalityProof(chain.blocks().at(-1));
    const witnesses = Array.from({ length: 4 }, generateWallet);
    const policy = createCheckpointWitnessPolicy({ chainIdentityGenesisHash: genesisHash,
      generation: 1, networkId: plan.networkId, threshold: 3,
      witnesses: witnesses.map((wallet, index) => ({ ...publicWallet(wallet),
        operatorId: `witness-${index}` })) });
    const v1Attestations = witnesses.slice(0, 3).map((wallet, index) =>
      createCheckpointWitnessAttestation({ finalityProof: proof,
        observedAt: Date.now() - 1000 + index, operatorId: `witness-${index}`,
        policy, sequence: 1, validators: compiled.genesis.validators, wallet }));
    const checkpointPackagePath = join(root, "checkpoint-package.json");
    const v1PackageBytes = JSON.stringify(assembleCheckpointTrustPackage({
      attestations: v1Attestations, finalityProof: proof, policy, sequence: 1,
      validators: compiled.genesis.validators,
    }));
    const certificateDirectory = join(root, "validator-state");
    mkdirSync(certificateDirectory);
    const context = { ...runtimeCertificateContext(certificateDirectory, compiled.genesis),
      currentHeight: 0, minimumActivationDelay: 0,
      peerRegistryHash: peerRegistryHash(compiled.genesis.peerRegistry),
      topologyHistoryHash: topologyHistoryCommitment() };
    const issue = createCertificateRecord({ activationHeight: 0,
      certificate: { serial: "10", sha256: tlsCertificateSha256 },
      networkId: plan.networkId, operation: "issue", overlapUntilHeight: 0,
      peerRegistryHash: peerRegistryHash(compiled.genesis.peerRegistry),
      previousRecordHash: EMPTY_CERTIFICATE_RECORD_HASH, sequence: 0,
      topologyHistoryHash: topologyHistoryCommitment(),
      validatorAddress: values.validators[0].address,
    }, values.validators.slice(0, 3));
    installCertificateRecord(join(certificateDirectory, "certificates"), issue, context);
    const certificateHeadAnchorPath = join(root, "certificate-anchor.json");
    writeFileSync(certificateHeadAnchorPath, JSON.stringify({
      format: "nir-certificate-history-anchor-v1",
      headHash: certificateHistoryHead([issue], context), networkId: plan.networkId,
      recordCount: 1, version: 1,
    }));
    const commitment = { certificateHistoryHead: certificateHistoryHead([issue], context),
      certificateRecordCount: 1 };
    const packageBytesFor = (selected) => {
      const attestations = witnesses.slice(0, 3).map((wallet, index) =>
        createCheckpointWitnessAttestationV2({ ...selected, finalityProof: proof,
          observedAt: Date.now() - 1000 + index, operatorId: `witness-${index}`,
          policy, sequence: 1, validators: compiled.genesis.validators, wallet }));
      return JSON.stringify(assembleCheckpointTrustPackageV2({ ...selected,
        attestations, finalityProof: proof, policy, sequence: 1,
        validators: compiled.genesis.validators }));
    };
    const packageBytes = packageBytesFor(commitment);
    writeFileSync(checkpointPackagePath, packageBytes);
    const probe = createTcpServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const cli = fileURLToPath(new URL("../blockchain/validator-transaction-ingress-cli.mjs",
      import.meta.url));
    const operatorPath = join(root, "operator.json");
    const operator = { certificateDirectory, certificateHeadAnchorPath,
      ceremonyAnchorPath: anchorPath, checkpointPackagePath,
      expectedGenesisHash: genesisHash, expectedNetworkId: plan.networkId,
      expectedPolicyId: policy.policyId, expectedTlsCertificateSha256: tlsCertificateSha256,
      expectedUpstreamOrigin: upstreamOrigin, floorDirectory: join(root, "floor"),
      format: "nir-transaction-ingress-operator-config-v1",
      listenHost: "127.0.0.1", listenPort: port, maxWitnessAgeMs: 30_000,
      registryDirectory, trustedReleaseSignerAddress: values.releaseOptions.trustedAddress,
      validatorAddress: values.validators[0].address, version: 1, walletOrigin: null };
    const writeOperator = (overrides = {}) => writeFileSync(operatorPath,
      `${canonicalJson({ ...operator, ...overrides })}\n`, { mode: 0o600 });
    writeOperator({ expectedGenesisHash: "f".repeat(64) });
    const failedStart = spawnSync(process.execPath, [cli, "--ceremony", operatorPath],
      { encoding: "utf8" });
    assert.equal(failedStart.status, 1);
    assert.match(failedStart.stderr, /genesis/);
    const linkedAnchorPath = join(root, "linked-anchor.json");
    symlinkSync(anchorPath, linkedAnchorPath);
    const oversizedAnchorPath = join(root, "oversized-anchor.json");
    writeFileSync(oversizedAnchorPath, " ".repeat(1024 * 1024 + 1), { mode: 0o600 });
    for (const unsafeAnchorPath of [linkedAnchorPath, oversizedAnchorPath]) {
      writeOperator({ ceremonyAnchorPath: unsafeAnchorPath });
      const rejected = spawnSync(process.execPath, [cli, "--ceremony", operatorPath],
        { encoding: "utf8" });
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /external ceremony anchor file is unsafe/);
    }
    writeOperator();
    writeFileSync(checkpointPackagePath, v1PackageBytes);
    const v1Initialization = spawnSync(process.execPath,
      [cli, "--init-floor", operatorPath], { encoding: "utf8" });
    assert.equal(v1Initialization.status, 1);
    assert.match(v1Initialization.stderr, /checkpoint v2 package envelope/);
    assert.equal(existsSync(operator.floorDirectory), false);
    writeFileSync(checkpointPackagePath, packageBytesFor({
      ...commitment, certificateRecordCount: 2 }));
    const wrongCountInitialization = spawnSync(process.execPath,
      [cli, "--init-floor", operatorPath], { encoding: "utf8" });
    assert.equal(wrongCountInitialization.status, 1);
    assert.match(wrongCountInitialization.stderr, /certificate head or count/);
    assert.equal(existsSync(operator.floorDirectory), false);
    writeFileSync(checkpointPackagePath, packageBytesFor({
      ...commitment, certificateHistoryHead: "f".repeat(64) }));
    const wrongHeadInitialization = spawnSync(process.execPath,
      [cli, "--init-floor", operatorPath], { encoding: "utf8" });
    assert.equal(wrongHeadInitialization.status, 1);
    assert.match(wrongHeadInitialization.stderr, /certificate head or count/);
    assert.equal(existsSync(operator.floorDirectory), false);
    writeFileSync(checkpointPackagePath, packageBytes);
    const insideCertificateAnchorPath = join(certificateDirectory, "inside-anchor.json");
    writeFileSync(insideCertificateAnchorPath,
      readFileSync(certificateHeadAnchorPath));
    writeOperator({ certificateHeadAnchorPath: insideCertificateAnchorPath });
    const insideAnchorInitialization = spawnSync(process.execPath,
      [cli, "--init-floor", operatorPath], { encoding: "utf8" });
    assert.equal(insideAnchorInitialization.status, 1);
    assert.match(insideAnchorInitialization.stderr, /external certificate history anchor must be outside node state/);
    assert.equal(existsSync(operator.floorDirectory), false);
    writeOperator();
    const missingFloor = spawnSync(process.execPath, [cli, "--ceremony", operatorPath],
      { encoding: "utf8" });
    assert.equal(missingFloor.status, 1);
    assert.match(missingFloor.stderr, /floor|ENOENT/);
    writeOperator({ expectedPolicyId: `sha3-256:${"f".repeat(64)}` });
    const invalidInitialization = spawnSync(process.execPath,
      [cli, "--init-floor", operatorPath], { encoding: "utf8" });
    assert.equal(invalidInitialization.status, 1);
    assert.match(invalidInitialization.stderr, /trust policy/);
    assert.equal(existsSync(operator.floorDirectory), false);
    writeOperator();
    const challengesBeforeInit = challengePosts;
    const initialized = spawnSync(process.execPath, [cli, "--init-floor", operatorPath],
      { encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(challengePosts, challengesBeforeInit);
    const repeatedInit = spawnSync(process.execPath, [cli, "--init-floor", operatorPath],
      { encoding: "utf8" });
    assert.equal(repeatedInit.status, 1);
    for (const [overrides, pattern] of [
      [{ expectedPolicyId: `sha3-256:${"f".repeat(64)}` }, /identity|trust policy/],
      [{ certificateHeadAnchorPath: join(root, "missing-certificate-anchor.json") },
        /ENOENT/],
      [{ maxWitnessAgeMs: 1 }, /witness time policy/],
    ]) {
      writeOperator(overrides);
      const rejected = spawnSync(process.execPath, [cli, "--ceremony", operatorPath],
        { encoding: "utf8" });
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, pattern);
    }
    writeOperator();
    writeFileSync(checkpointPackagePath, v1PackageBytes);
    const challengesBeforeV1Start = challengePosts;
    const v1Start = spawnSync(process.execPath, [cli, "--ceremony", operatorPath],
      { encoding: "utf8" });
    assert.equal(v1Start.status, 1);
    assert.match(v1Start.stderr, /checkpoint v2 package envelope/);
    assert.equal(challengePosts, challengesBeforeV1Start);
    writeFileSync(checkpointPackagePath, packageBytes);
    const available = createTcpServer();
    await new Promise((resolve) => available.listen(port, "127.0.0.1", resolve));
    await new Promise((resolve) => available.close(resolve));
    const running = spawn(process.execPath, [cli, "--ceremony", operatorPath],
      { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ceremony-bound ingress did not listen")), 5_000);
        running.stdout.on("data", (chunk) => {
          if (chunk.toString().includes("ceremony-bound startup")) {
            clearTimeout(timer); resolve();
          }
        });
        running.once("exit", (code) => {
          clearTimeout(timer); reject(new Error(`ceremony-bound ingress exited ${code}`));
        });
      });
      const response = await fetch(`http://127.0.0.1:${port}/v1/transactions`);
      assert.equal(response.status, 404);
      const transaction = createTransfer({ wallet: generateWallet(),
        networkId: plan.networkId, recipient: generateWallet().address,
        amount: "1000000", nonce: 0 });
      const submit = () => fetch(`http://127.0.0.1:${port}/v1/transactions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(transaction),
      });
      assert.equal((await submit()).status, 502);
      assert.equal(transactionPosts, 1);
      writeFileSync(checkpointPackagePath, "{}\n");
      assert.equal((await submit()).status, 503);
      assert.equal(transactionPosts, 1);
      writeFileSync(checkpointPackagePath, packageBytes);
    } finally {
      if (running.exitCode === null) {
        const exited = new Promise((resolve) => running.once("exit", resolve));
        running.kill("SIGTERM");
        await exited;
      }
    }
    wrongSigner = true;
    const forged = spawn(process.execPath, [cli, "--ceremony", operatorPath],
      { stdio: ["ignore", "ignore", "pipe"] });
    let forgedError = "";
    forged.stderr.on("data", (chunk) => { forgedError += chunk.toString(); });
    const forgedExit = await new Promise((resolve) => forged.once("exit", resolve));
    assert.equal(forgedExit, 1);
    assert.match(forgedError, /live identity signature or binding/);
    const afterForged = createTcpServer();
    await new Promise((resolve) => afterForged.listen(port, "127.0.0.1", resolve));
    await new Promise((resolve) => afterForged.close(resolve));
    wrongSigner = false;
    for (const changed of [
      { anchor: null }, { expectedGenesisHash: "f".repeat(64) },
      { trustedReleaseSignerAddress: values.operators[0].address },
      { validatorAddress: values.validators[1].address },
      { expectedNetworkId: "foreign-network" },
      { expectedUpstreamOrigin: "https://127.0.0.1:8792" },
      { expectedTlsCertificateSha256: "b".repeat(64) },
    ]) {
      assert.throws(() => verifyCeremonyBoundTransactionIngressConfig({ ...options, ...changed }));
    }
    const foreign = v2Fixture("foreign-ingress-startup");
    foreign.input.validators[0].endpoint = upstreamOrigin;
    foreign.input.validators[0].tlsCertificateSha256 = tlsCertificateSha256;
    const other = approved(foreign);
    const foreignRegistry = join(root, "foreign-registry");
    appendCeremonyRegistry(foreignRegistry, other.plan, other.envelope, foreign.releaseOptions);
    const foreignState = verifyCeremonyRegistry(foreignRegistry,
      { trustedAddress: foreign.releaseOptions.trustedAddress });
    const foreignPayload = createCeremonyRegistryAnchorPayload(foreignState);
    const foreignApprovals = foreign.operators.slice(0, 3).map((wallet) =>
      signCeremonyRegistryAnchor(foreignPayload, other.plan, wallet, foreign.releaseOptions));
    const foreignAnchor = assembleCeremonyRegistryAnchor(foreignPayload, other.plan,
      foreignApprovals, foreign.releaseOptions);
    assert.throws(() => verifyCeremonyBoundTransactionIngressConfig({ ...options,
      anchor: foreignAnchor, registryDirectory: foreignRegistry,
      trustedReleaseSignerAddress: foreign.releaseOptions.trustedAddress,
      validatorAddress: foreign.validators[0].address,
      expectedNetworkId: other.plan.networkId,
    }), /genesis/);
    const foreignAnchorPath = join(root, "foreign-anchor.json");
    writeFileSync(foreignAnchorPath, JSON.stringify(foreignAnchor));
    writeOperator({ ceremonyAnchorPath: foreignAnchorPath,
      registryDirectory: foreignRegistry,
      trustedReleaseSignerAddress: foreign.releaseOptions.trustedAddress,
      validatorAddress: foreign.validators[0].address,
      expectedNetworkId: other.plan.networkId });
    const rejectedForeignStart = spawnSync(process.execPath,
      [cli, "--ceremony", operatorPath], { encoding: "utf8" });
    assert.equal(rejectedForeignStart.status, 1);
    assert.match(rejectedForeignStart.stderr, /genesis/);
    const afterForeign = createTcpServer();
    await new Promise((resolve) => afterForeign.listen(port, "127.0.0.1", resolve));
    await new Promise((resolve) => afterForeign.close(resolve));
  } finally {
    if (upstream?.listening) {
      const closed = new Promise((resolve) => upstream.close(resolve));
      upstream.closeAllConnections?.();
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy v1 ceremony genesis cannot acquire the v27 environment retroactively", () => {
  const values = fixture("legacy-upgrade-limit");
  const { plan, envelope } = approved(values);
  const chain = new NirChain(compileGenesis(plan, envelope, values.releaseOptions).genesis);
  for (let version = 25; version <= 27; version += 1) {
    const activationHeight = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
    const proposal = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1,
      protocolUpgrade: { activationHeight, format: "nir-protocol-upgrade-v1", version } });
    chain.appendBlock(finalizeBlock(proposal, values.validators.slice(0, 3)));
    while (chain.height < activationHeight - 1) {
      const block = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1 });
      chain.appendBlock(finalizeBlock(block, values.validators.slice(0, 3)));
    }
    if (version === 27) {
      const block = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1 });
      assert.throws(() => chain.appendBlock(finalizeBlock(block,
        values.validators.slice(0, 3))), /lacks a genesis evaluation environment/);
    } else {
      const block = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1 });
      chain.appendBlock(finalizeBlock(block, values.validators.slice(0, 3)));
      assert.equal(chain.protocolVersion, version);
    }
  }
});

test("public genesis plans are canonical, exact, public-only commitments", () => {
  const values = fixture();
  const plan = createGenesisPlan(values.input, values.releaseOptions);
  const reordered = structuredClone(values.input);
  reordered.validators.reverse();
  reordered.evaluators.reverse();
  reordered.beaconAuthorities.reverse();
  reordered.ceremonyOperators.reverse();
  reordered.treasury.memberPublicKeys.reverse();
  assert.deepEqual(createGenesisPlan(reordered, values.releaseOptions), plan);
  assert.deepEqual(verifyGenesisPlan(plan, values.releaseOptions), plan);
  assert.equal(JSON.stringify(plan).includes("privateKey"), false);

  assert.throws(() => createGenesisPlan(
    { ...values.input, privateKey: "forbidden" }, values.releaseOptions,
  ),
    /secret or private/);
  assert.throws(() => createGenesisPlan(
    { ...values.input, unknown: true }, values.releaseOptions,
  ), /unknown fields/);
  assert.throws(() => createGenesisPlan(
    { ...values.input, protocolVersion: PROTOCOL_VERSION + 1 }, values.releaseOptions,
  ),
    /unsupported/);
  const omittedAnchor = structuredClone(values.input);
  delete omittedAnchor.protocolUpgradeReleaseAnchor;
  assert.throws(() => createGenesisPlan(omittedAnchor, values.releaseOptions), /schema/);
  const wrongNetworkAnchor = structuredClone(values.input);
  wrongNetworkAnchor.protocolUpgradeReleaseAnchor.networkId = "nir-foreign-valueless-devnet";
  assert.throws(() => createGenesisPlan(wrongNetworkAnchor, values.releaseOptions),
    /another network|anchor/);
  const tamperedAnchor = structuredClone(values.input);
  tamperedAnchor.protocolUpgradeReleaseAnchor.anchorHash = `sha3-256:${"0".repeat(64)}`;
  assert.throws(() => createGenesisPlan(tamperedAnchor, values.releaseOptions), /anchor hash/);
  const duplicate = structuredClone(values.input);
  duplicate.ceremonyOperators[1].contribution = duplicate.ceremonyOperators[0].contribution;
  assert.throws(() => createGenesisPlan(duplicate, values.releaseOptions), /duplicated/);
  const badTreasury = structuredClone(values.input);
  badTreasury.treasury.threshold = 3;
  assert.throws(() => createGenesisPlan(badTreasury, values.releaseOptions), /2-of-3/);
});

test("ceremony verification requires unique known operator quorum on unchanged commitment", () => {
  const values = fixture();
  const { approvals, envelope, plan, registryApprovals } = approved(values);
  assert.deepEqual(verifyGenesisCeremony(plan, envelope, values.releaseOptions), {
    commitment: plan.commitment,
    peerRegistrySigners: registryApprovals.map(({ validator }) => validator).sort(),
    quorum: 3,
    registryQuorum: 3,
    signers: ["ceremony-0", "ceremony-1", "ceremony-2"],
    verified: true,
  });
  const insufficient = createGenesisApprovalEnvelope(
    plan, approvals.slice(0, 2), registryApprovals, values.releaseOptions,
  );
  assert.throws(() => verifyGenesisCeremony(plan, insufficient, values.releaseOptions), /quorum/);
  const duplicated = createGenesisApprovalEnvelope(
    plan, [approvals[0], approvals[0], approvals[1]], registryApprovals, values.releaseOptions,
  );
  assert.throws(() => verifyGenesisCeremony(plan, duplicated, values.releaseOptions), /duplicated/);
  const unknown = createGenesisApprovalEnvelope(plan, [
    ...approvals.slice(0, 2), { ...approvals[2], operatorId: "unknown-operator" },
  ], registryApprovals, values.releaseOptions);
  assert.throws(() => verifyGenesisCeremony(plan, unknown, values.releaseOptions), /unknown/);
  const mutated = structuredClone(plan);
  mutated.validators[0].endpoint = "http://127.0.0.1:9999";
  assert.throws(() => verifyGenesisCeremony(mutated, envelope, values.releaseOptions), /commitment/);
  assert.throws(() => signGenesisPlan(
    plan, generateWallet(), values.releaseOptions,
  ), /not a ceremony operator/);
});

test("every ceremony stage is bound to one trusted signed source release", () => {
  const values = fixture("release-binding");
  const { approvals, envelope, plan, registryApprovals } = approved(values);
  assert.deepEqual(plan.sourceRelease, {
    manifestHash: values.releaseOptions.signedRelease.manifest.manifestHash,
    releaseVersion: values.releaseOptions.signedRelease.manifest.releaseVersion,
    signerAddress: values.releaseOptions.trustedAddress,
    sourceRevision: values.releaseOptions.signedRelease.manifest.sourceRevision,
  });
  assert.throws(() => verifyGenesisCeremony(plan, envelope), /requires a signed release/);
  assert.throws(() => createGenesisApprovalEnvelope(
    plan, approvals, registryApprovals,
  ), /requires a signed release/);
  assert.throws(() => compileGenesis(plan, envelope), /requires a signed release/);
  assert.throws(() => verifyGenesisCeremony(plan, envelope, {
    ...values.releaseOptions, trustedAddress: generateWallet().address,
  }), /not trusted/);

  const other = fixture("valid-other-release", { releaseSigner: values.releaseSigner });
  assert.throws(() => verifyGenesisCeremony(plan, envelope, other.releaseOptions),
    /does not match/);
  const mutatedRelease = structuredClone(values.releaseOptions.signedRelease);
  mutatedRelease.manifest.releaseVersion = "0.2.1";
  assert.throws(() => verifyGenesisCeremony(plan, envelope, {
    signedRelease: mutatedRelease, trustedAddress: values.releaseOptions.trustedAddress,
  }), /manifest hash|not trusted/);
  const leakedRelease = structuredClone(values.releaseOptions.signedRelease);
  leakedRelease.signer.privateKey = "forbidden";
  assert.throws(() => verifyGenesisCeremony(plan, envelope, {
    signedRelease: leakedRelease, trustedAddress: values.releaseOptions.trustedAddress,
  }), /secret or private/);
  const mutatedPlan = structuredClone(plan);
  mutatedPlan.sourceRelease.sourceRevision = "f".repeat(64);
  assert.throws(() => verifyGenesisCeremony(mutatedPlan, envelope, values.releaseOptions),
    /does not match/);
  const prerelease = fixture("prerelease", { releaseVersion: "0.2.0-alpha.10" });
  assert.throws(() => createGenesisPlan(prerelease.input, prerelease.releaseOptions),
    /major\.minor\.patch/);
});

test("prior public plans reject reused network ids and operator contributions", () => {
  const firstValues = fixture("first");
  const first = approved(firstValues);

  const sameNetworkValues = fixture("second");
  sameNetworkValues.input.networkId = first.plan.networkId;
  sameNetworkValues.input.protocolUpgradeReleaseAnchor = createReleaseTransparencyAnchor({
    initialSet: sameNetworkValues.input.protocolUpgradeReleaseAnchor.initialSet,
    logId: sameNetworkValues.input.protocolUpgradeReleaseAnchor.logId,
    networkId: first.plan.networkId,
  });
  const sameNetwork = approved(sameNetworkValues);
  assert.throws(() => verifyGenesisCeremony(
    sameNetwork.plan, sameNetwork.envelope, {
      ...sameNetworkValues.releaseOptions, priorPlans: [first.plan],
    },
  ), /network id/);

  const reusedContributionValues = fixture("third");
  reusedContributionValues.input.ceremonyOperators[0].contribution =
    first.plan.ceremonyOperators[0].contribution;
  const reusedContribution = approved(reusedContributionValues);
  assert.throws(() => verifyGenesisCeremony(
    reusedContribution.plan, reusedContribution.envelope, {
      ...reusedContributionValues.releaseOptions, priorPlans: [first.plan],
    },
  ), /contribution/);
});

test("compile emits the existing deterministic genesis config and round-trips its chain hash", () => {
  const values = fixture();
  const { envelope, plan } = approved(values);
  const first = compileGenesis(plan, envelope, values.releaseOptions);
  const second = compileGenesis(plan, envelope, values.releaseOptions);
  assert.deepEqual(first, second);
  const reorderedEnvelope = structuredClone(envelope);
  reorderedEnvelope.peerRegistryApprovals.reverse();
  assert.deepEqual(compileGenesis(plan, reorderedEnvelope, values.releaseOptions), first);
  assert.equal(first.genesis.peerRegistry.signatures.length, 3);
  assert.equal(first.genesis.peerRegistry.peers.length, 4);
  assert.equal("protocolVersion" in first.genesis, false);
  assert.deepEqual(first.genesis.protocolUpgradeReleaseAnchor,
    plan.protocolUpgradeReleaseAnchor);
  assert.equal(JSON.stringify(first.genesis).includes("endpoint"), false);
  assert.equal(JSON.stringify(first.genesis).includes("contribution"), false);
  const chain = new NirChain(first.genesis);
  assert.equal(chain.blocks()[0].hash, first.genesisHash);
  const announcement = createPeerAnnouncement({
    height: 0,
    networkId: first.genesis.networkId,
    registry: first.genesis.peerRegistry,
    tipHash: first.genesisHash,
  }, values.validatorTransports[0]);
  const trustedTransport = first.genesis.peerRegistry.peers.find(
    ({ transport }) => transport.address === values.validatorTransports[0].address,
  ).transport;
  assert.equal(verifyPeerAnnouncement(announcement, {
    expectedNetworkId: first.genesis.networkId,
    expectedRegistryHash: peerRegistryHash(first.genesis.peerRegistry),
    trustedTransport,
  }).tipHash, first.genesisHash);
  assert.equal(first.planCommitment, plan.commitment);
});

test("two-copy ceremony registry detects rollback, repairs one copy, and rejects reuse", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-genesis-registry-"));
  try {
    const registry = join(root, "registry");
    const releaseSigner = generateWallet();
    const firstValues = fixture("registry-first", { releaseSigner, releaseVersion: "0.2.0" });
    const secondValues = fixture("registry-second", { releaseSigner, releaseVersion: "0.3.0" });
    const first = approved(firstValues);
    const second = approved(secondValues);
    appendCeremonyRegistry(registry, first.plan, first.envelope, firstValues.releaseOptions);
    const trust = { trustedAddress: releaseSigner.address };
    const oneRecord = verifyCeremonyRegistry(registry, trust).records;
    appendCeremonyRegistry(registry, second.plan, second.envelope, secondValues.releaseOptions);
    assert.equal(verifyCeremonyRegistry(registry, trust).count, 2);
    assert.throws(() => appendCeremonyRegistry(
      registry, first.plan, first.envelope, firstValues.releaseOptions,
    ),
      /already used/);
    const olderValues = fixture("registry-older", {
      releaseSigner, releaseVersion: "0.1.0",
    });
    const older = approved(olderValues);
    assert.throws(() => appendCeremonyRegistry(
      registry, older.plan, older.envelope, olderValues.releaseOptions,
    ), /version rolled back/);

    const paths = ceremonyRegistryPaths(registry);
    writeFileSync(paths.primary, `${JSON.stringify(oneRecord)}\n`);
    assert.throws(() => verifyCeremonyRegistry(registry, trust), /rolled back/);
    assert.equal(repairCeremonyRegistryOneCopy(registry, trust).repaired, true);
    assert.equal(verifyCeremonyRegistry(registry, trust).count, 2);

    rmSync(paths.primary);
    symlinkSync(paths.backup, paths.primary);
    assert.throws(() => verifyCeremonyRegistry(registry, trust), /invalid/);
    assert.equal(repairCeremonyRegistryOneCopy(registry, trust).repaired, true);
    assert.equal(verifyCeremonyRegistry(registry, trust).count, 2);

    mkdirSync(join(registry, ".GENESIS-CEREMONY.writer.lock"));
    assert.throws(() => repairCeremonyRegistryOneCopy(registry, trust), /EEXIST/);
    rmSync(join(registry, ".GENESIS-CEREMONY.writer.lock"), { recursive: true });

    const registryLink = join(root, "registry-link");
    symlinkSync(registry, registryLink);
    assert.throws(() => verifyCeremonyRegistry(registryLink, trust), /unsafe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ceremony registry refuses ambiguous valid divergence", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-genesis-divergence-"));
  try {
    const left = join(root, "left");
    const right = join(root, "right");
    const releaseSigner = generateWallet();
    const firstValues = fixture("divergence-first", { releaseSigner, releaseVersion: "0.2.0" });
    const secondValues = fixture("divergence-second", { releaseSigner, releaseVersion: "0.3.0" });
    const thirdValues = fixture("divergence-third", { releaseSigner, releaseVersion: "0.3.0" });
    const first = approved(firstValues);
    const second = approved(secondValues);
    const third = approved(thirdValues);
    const trust = { trustedAddress: releaseSigner.address };
    appendCeremonyRegistry(left, first.plan, first.envelope, firstValues.releaseOptions);
    appendCeremonyRegistry(right, first.plan, first.envelope, firstValues.releaseOptions);
    appendCeremonyRegistry(left, second.plan, second.envelope, secondValues.releaseOptions);
    appendCeremonyRegistry(right, third.plan, third.envelope, thirdValues.releaseOptions);
    const leftPaths = ceremonyRegistryPaths(left);
    const rightPaths = ceremonyRegistryPaths(right);
    writeFileSync(leftPaths.primary, readFileSync(rightPaths.primary));
    assert.throws(() => verifyCeremonyRegistry(left, trust), /diverged/);
    assert.throws(() => repairCeremonyRegistryOneCopy(left, trust), /ambiguous/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ceremony registry pins its root descriptor against a post-open symlink swap", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-genesis-root-swap-"));
  try {
    const registry = join(root, "registry");
    const moved = join(root, "registry-original");
    const decoy = join(root, "decoy");
    const releaseSigner = generateWallet();
    const firstValues = fixture("root-swap-first", { releaseSigner });
    const secondValues = fixture("root-swap-second", { releaseSigner, releaseVersion: "0.3.0" });
    const first = approved(firstValues);
    const second = approved(secondValues);
    appendCeremonyRegistry(registry, first.plan, first.envelope, firstValues.releaseOptions);
    mkdirSync(decoy);
    assert.throws(() => appendCeremonyRegistry(
      registry, second.plan, second.envelope, {
        ...secondValues.releaseOptions,
        _afterRootOpen({ root: openedRoot }) {
          assert.equal(openedRoot, registry);
          renameSync(registry, moved);
          symlinkSync(decoy, registry);
        },
      },
    ), /root changed/);
    assert.deepEqual(readdirSync(decoy), []);
    const trust = { trustedAddress: releaseSigner.address };
    assert.equal(verifyCeremonyRegistry(moved, trust).count, 1);
    rmSync(registry);
    renameSync(moved, registry);
    assert.equal(verifyCeremonyRegistry(registry, trust).count, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external operator anchor detects coordinated rollback and permits anchored extensions", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-genesis-anchor-"));
  try {
    const registry = join(root, "registry");
    const releaseSigner = generateWallet();
    const firstValues = fixture("anchor-first", { releaseSigner, releaseVersion: "0.2.0" });
    const secondValues = fixture("anchor-second", { releaseSigner, releaseVersion: "0.3.0" });
    const thirdValues = fixture("anchor-third", { releaseSigner, releaseVersion: "0.4.0" });
    const first = approved(firstValues);
    const second = approved(secondValues);
    const third = approved(thirdValues);
    const trust = { trustedAddress: releaseSigner.address };
    appendCeremonyRegistry(registry, first.plan, first.envelope, firstValues.releaseOptions);
    const firstRecords = verifyCeremonyRegistry(registry, trust).records;
    appendCeremonyRegistry(registry, second.plan, second.envelope, secondValues.releaseOptions);
    const state = verifyCeremonyRegistry(registry, trust);
    const payload = createCeremonyRegistryAnchorPayload(state);
    const approvals = secondValues.operators.slice(0, 3).map((wallet) =>
      signCeremonyRegistryAnchor(payload, second.plan, wallet, secondValues.releaseOptions));
    const anchor = assembleCeremonyRegistryAnchor(
      payload, second.plan, approvals, secondValues.releaseOptions,
    );
    assert.equal(verifyCeremonyRegistryAnchor(anchor, state.records, trust).verified, true);

    assert.throws(() => assembleCeremonyRegistryAnchor(
      payload, second.plan, approvals.slice(0, 2), secondValues.releaseOptions,
    ), /quorum/);
    assert.throws(() => assembleCeremonyRegistryAnchor(
      payload, second.plan, [approvals[0], approvals[0], approvals[1]],
      secondValues.releaseOptions,
    ), /duplicated/);
    assert.throws(() => assembleCeremonyRegistryAnchor(
      payload, second.plan, [
        approvals[0], approvals[1], { ...approvals[2], operatorId: "unknown-anchor" },
      ], secondValues.releaseOptions,
    ), /unknown/);

    appendCeremonyRegistry(registry, third.plan, third.envelope, {
      ...thirdValues.releaseOptions, anchor,
    });
    const extended = verifyCeremonyRegistry(registry, { ...trust, anchor });
    assert.equal(extended.count, 3);
    assert.equal(verifyCeremonyRegistryAnchor(anchor, extended.records, trust).localCount, 3);

    const paths = ceremonyRegistryPaths(registry);
    const extendedContents = readFileSync(paths.primary);
    const rolledBackContents = Buffer.from(`${JSON.stringify(firstRecords)}\n`);
    writeFileSync(paths.primary, rolledBackContents);
    writeFileSync(paths.backup, rolledBackContents);
    assert.throws(() => verifyCeremonyRegistry(registry, { ...trust, anchor }), /behind/);
    assert.throws(() => appendCeremonyRegistry(
      registry, third.plan, third.envelope, { ...thirdValues.releaseOptions, anchor },
    ), /behind/);
    assert.throws(() => repairCeremonyRegistryOneCopy(registry, { ...trust, anchor }), /behind/);
    writeFileSync(paths.primary, extendedContents);
    writeFileSync(paths.backup, extendedContents);

    const wrongHead = structuredClone(anchor);
    wrongHead.payload.registryHead = "f".repeat(64);
    assert.throws(() => verifyCeremonyRegistry(registry, { ...trust, anchor: wrongHead }),
      /not a prefix/);
    const mutated = structuredClone(anchor);
    mutated.payload.latestGenesisHash = "e".repeat(64);
    assert.throws(() => verifyCeremonyRegistry(registry, { ...trust, anchor: mutated }),
      /not a prefix/);

    rmSync(paths.primary);
    symlinkSync(paths.backup, paths.primary);
    assert.equal(repairCeremonyRegistryOneCopy(registry, { ...trust, anchor }).repaired, true);
    assert.equal(verifyCeremonyRegistry(registry, { ...trust, anchor }).count, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("genesis ceremony CLI plans, assembles, verifies, and compiles public artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-genesis-ceremony-"));
  const cli = new URL("../blockchain/genesis-ceremony-cli.mjs", import.meta.url).pathname;
  try {
    const values = fixture("cli");
    const inputPath = join(root, "input.json");
    const releasePath = join(root, "signed-release.json");
    const planPath = join(root, "plan.json");
    const approvalsPath = join(root, "approvals.json");
    const envelopePath = join(root, "envelope.json");
    const genesisPath = join(root, "genesis.json");
    const registryPath = join(root, "registry");
    const anchorPayloadPath = join(root, "anchor-payload.json");
    const anchorApprovalsPath = join(root, "anchor-approvals.json");
    const anchorPath = join(root, "anchor.json");
    writeFileSync(inputPath, JSON.stringify(values.input));
    writeFileSync(releasePath, JSON.stringify(values.releaseOptions.signedRelease));
    const planned = spawnSync(process.execPath, [
      cli, "plan", inputPath, releasePath, values.releaseOptions.trustedAddress, planPath,
    ], {
      encoding: "utf8",
    });
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    const approvals = values.operators.slice(0, 3)
      .map((wallet) => signGenesisPlan(plan, wallet, values.releaseOptions));
    const peerRegistryApprovals = values.validators.slice(0, 3)
      .map((wallet) => signGenesisPeerRegistry(plan, wallet, values.releaseOptions));
    writeFileSync(approvalsPath, JSON.stringify({ approvals, peerRegistryApprovals }));
    const assembled = spawnSync(process.execPath, [
      cli, "assemble", planPath, releasePath, values.releaseOptions.trustedAddress,
      approvalsPath, envelopePath,
    ], { encoding: "utf8" });
    assert.equal(assembled.status, 0, assembled.stderr);
    const verified = spawnSync(process.execPath, [
      cli, "verify", planPath, envelopePath, releasePath, values.releaseOptions.trustedAddress,
    ], {
      encoding: "utf8",
    });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /valueless developer testnet ceremony verified/i);
    const compiled = spawnSync(process.execPath, [
      cli, "compile", planPath, envelopePath, releasePath,
      values.releaseOptions.trustedAddress, genesisPath,
    ], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr);
    assert.match(compiled.stdout, /valueless developer testnet only/i);
    const genesis = JSON.parse(readFileSync(genesisPath, "utf8"));
    assert.match(new NirChain(genesis).blocks()[0].hash, /^[0-9a-f]{64}$/);
    const appended = spawnSync(process.execPath, [
      cli, "registry-append", registryPath, planPath, envelopePath, releasePath,
      values.releaseOptions.trustedAddress,
    ], { encoding: "utf8" });
    assert.equal(appended.status, 0, appended.stderr);
    const exportedAnchor = spawnSync(process.execPath, [
      cli, "export-anchor-payload", registryPath, values.releaseOptions.trustedAddress,
      anchorPayloadPath,
    ], { encoding: "utf8" });
    assert.equal(exportedAnchor.status, 0, exportedAnchor.stderr);
    const anchorPayload = JSON.parse(readFileSync(anchorPayloadPath, "utf8"));
    const anchorApprovals = values.operators.slice(0, 3).map((wallet) =>
      signCeremonyRegistryAnchor(anchorPayload, plan, wallet, values.releaseOptions));
    writeFileSync(anchorApprovalsPath, JSON.stringify(anchorApprovals));
    const assembledAnchor = spawnSync(process.execPath, [
      cli, "assemble-anchor", anchorPayloadPath, planPath, releasePath,
      values.releaseOptions.trustedAddress, anchorApprovalsPath, anchorPath,
    ], { encoding: "utf8" });
    assert.equal(assembledAnchor.status, 0, assembledAnchor.stderr);
    const anchoredVerify = spawnSync(process.execPath, [
      cli, "verify-with-anchor", registryPath, values.releaseOptions.trustedAddress, anchorPath,
    ], { encoding: "utf8" });
    assert.equal(anchoredVerify.status, 0, anchoredVerify.stderr);
    const registryPaths = ceremonyRegistryPaths(registryPath);
    rmSync(registryPaths.primary);
    symlinkSync(registryPaths.backup, registryPaths.primary);
    const failedVerify = spawnSync(process.execPath, [
      cli, "registry-verify", registryPath, values.releaseOptions.trustedAddress,
    ], { encoding: "utf8" });
    assert.equal(failedVerify.status, 1);
    const repaired = spawnSync(process.execPath, [
      cli, "registry-repair-one-copy", registryPath, values.releaseOptions.trustedAddress,
      anchorPath,
    ], { encoding: "utf8" });
    assert.equal(repaired.status, 0, repaired.stderr);
    const registryVerified = spawnSync(process.execPath, [
      cli, "registry-verify", registryPath, values.releaseOptions.trustedAddress,
      anchorPath,
    ], { encoding: "utf8" });
    assert.equal(registryVerified.status, 0, registryVerified.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
