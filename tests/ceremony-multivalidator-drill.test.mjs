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
  blockHash, createMultisigTransfer, multisigAddress, NirChain,
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
