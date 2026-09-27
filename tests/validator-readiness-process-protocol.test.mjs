import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { encryptWallet } from "../blockchain/vault.mjs";
import {
  createValidatorReadinessHeightUpdate,
  createValidatorReadinessProcessBootstrapSet,
  createValidatorReadinessSignerReady,
  verifyValidatorReadinessGatewayProcessBootstrap,
  verifyValidatorReadinessHeightUpdate,
  verifyValidatorReadinessSignerProcessBootstrap,
  verifyValidatorReadinessSignerReady,
} from "../blockchain/validator-readiness-process-protocol.mjs";
import {
  READINESS_SIGNER_NOW, validatorReadinessSignerFixture,
} from "./validator-readiness-signer-fixture.mjs";

const SOURCE = readFileSync(new URL(
  "../blockchain/validator-readiness-process-protocol.mjs", import.meta.url), "utf8");

function setup() {
  const values = validatorReadinessSignerFixture();
  const consensusVault = encryptWallet(values.candidate, "consensus-process-test-password", {
    label: "Consensus process",
  });
  const transportVault = encryptWallet(values.transport, "transport-process-test-password", {
    label: "Transport process",
  });
  const bootstraps = createValidatorReadinessProcessBootstrapSet({
    consensusVault, gatewayRolePackage: values.gatewayRolePackage,
    initialHeight: values.context.checkpoint.height,
    tlsCertificateSha256: values.context.tlsCertificateSha256, transportVault,
  }, { now: READINESS_SIGNER_NOW });
  return { ...values, ...bootstraps, consensusVault, transportVault };
}

function launchTrust(values) {
  return { expectedLauncherNonce: values.launcherNonce,
    expectedReleaseProvenanceHash: values.session.releaseProvenanceHash,
    expectedSessionHash: values.session.sessionHash };
}

test("one launch creates three role-separated, mutually bound bootstrap packages", () => {
  const values = setup();
  const consensus = verifyValidatorReadinessSignerProcessBootstrap(
    values.consensusSignerBootstrap,
    { encryptedVault: values.consensusVault, expectedRole: "consensus", now: READINESS_SIGNER_NOW,
      ...launchTrust(values) });
  const transport = verifyValidatorReadinessSignerProcessBootstrap(
    values.transportSignerBootstrap,
    { encryptedVault: values.transportVault, expectedRole: "transport", now: READINESS_SIGNER_NOW,
      ...launchTrust(values) });
  const gateway = verifyValidatorReadinessGatewayProcessBootstrap(values.gatewayBootstrap, {
    consensusSignerBootstrap: consensus, now: READINESS_SIGNER_NOW,
    transportSignerBootstrap: transport, ...launchTrust(values),
  });
  assert.equal(consensus.launcherNonce, transport.launcherNonce);
  assert.equal(gateway.launcherNonce, consensus.launcherNonce);
  assert.notEqual(consensus.bootstrapHash, transport.bootstrapHash);
  assert.notEqual(gateway.bootstrapHash, consensus.bootstrapHash);
  assert.equal(JSON.stringify(consensus).includes("ciphertext"), false);

  assert.throws(() => verifyValidatorReadinessSignerProcessBootstrap(
    values.consensusSignerBootstrap,
    { encryptedVault: values.transportVault, expectedRole: "consensus", now: READINESS_SIGNER_NOW,
      ...launchTrust(values) }));
  assert.throws(() => verifyValidatorReadinessSignerProcessBootstrap(
    values.consensusSignerBootstrap,
    { encryptedVault: values.consensusVault, expectedRole: "transport", now: READINESS_SIGNER_NOW,
      ...launchTrust(values) }));
});

test("bootstrap verification fails closed on mutations and mixed launches", () => {
  const values = setup();
  const other = createValidatorReadinessProcessBootstrapSet({
    consensusVault: values.consensusVault, gatewayRolePackage: values.gatewayRolePackage,
    initialHeight: values.context.checkpoint.height,
    tlsCertificateSha256: values.context.tlsCertificateSha256,
    transportVault: values.transportVault,
  }, { now: READINESS_SIGNER_NOW });
  assert.notEqual(other.launcherNonce, values.launcherNonce);
  assert.throws(() => verifyValidatorReadinessGatewayProcessBootstrap(values.gatewayBootstrap, {
    consensusSignerBootstrap: other.consensusSignerBootstrap, now: READINESS_SIGNER_NOW,
    transportSignerBootstrap: values.transportSignerBootstrap, ...launchTrust(values),
  }));
  for (const mutate of [
    (copy) => { copy.extra = true; },
    (copy) => { copy.tlsCertificateSha256 = "0".repeat(64); },
    (copy) => { copy.consensusSignerBootstrapHash = "sha3-256:" + "0".repeat(64); },
    (copy) => { copy.limits.maxActivePerAddress = copy.limits.maxActive + 1; },
    (copy) => { copy.limits.extra = 1; },
  ]) {
    const changed = structuredClone(values.gatewayBootstrap); mutate(changed);
    assert.throws(() => verifyValidatorReadinessGatewayProcessBootstrap(changed, {
      consensusSignerBootstrap: values.consensusSignerBootstrap, now: READINESS_SIGNER_NOW,
      transportSignerBootstrap: values.transportSignerBootstrap, ...launchTrust(values),
    }));
  }
  for (const mutate of [
    (copy) => { copy.extra = true; },
    (copy) => { copy.initialHeight += 1; },
    (copy) => { copy.launcherNonce = "0".repeat(64); },
    (copy) => { copy.rolePackageHash = "sha3-256:" + "0".repeat(64); },
    (copy) => { copy.vaultCommitment.vaultHash = "sha3-256:" + "0".repeat(64); },
    (copy) => { copy.rolePackage.role = "transport"; },
  ]) {
    const changed = structuredClone(values.consensusSignerBootstrap); mutate(changed);
    assert.throws(() => verifyValidatorReadinessSignerProcessBootstrap(changed, {
      encryptedVault: values.consensusVault, expectedRole: "consensus", now: READINESS_SIGNER_NOW,
      ...launchTrust(values),
    }));
  }
});

test("verifiers require launcher-local launch, release, session, and child PID pins", () => {
  const values = setup();
  const base = { encryptedVault: values.consensusVault, expectedRole: "consensus",
    now: READINESS_SIGNER_NOW, ...launchTrust(values) };
  for (const field of ["expectedLauncherNonce", "expectedReleaseProvenanceHash",
    "expectedSessionHash"]) {
    const missing = { ...base }; delete missing[field];
    assert.throws(() => verifyValidatorReadinessSignerProcessBootstrap(
      values.consensusSignerBootstrap, missing), /local launch binding|expected launcher nonce/);
    assert.throws(() => verifyValidatorReadinessSignerProcessBootstrap(
      values.consensusSignerBootstrap, { ...base, [field]: "0".repeat(64) }),
    /local launch binding/);
  }

  const ready = createValidatorReadinessSignerReady({
    bootstrap: values.consensusSignerBootstrap, pid: 1234, wallet: values.candidate,
  }, { now: READINESS_SIGNER_NOW });
  assert.throws(() => verifyValidatorReadinessSignerReady(ready, {
    bootstrap: values.consensusSignerBootstrap, expectedRole: "consensus",
    now: READINESS_SIGNER_NOW, ...launchTrust(values),
  }), /PID binding/);
  assert.throws(() => verifyValidatorReadinessSignerReady(ready, {
    bootstrap: values.consensusSignerBootstrap, expectedRole: "consensus", expectedPid: 4321,
    now: READINESS_SIGNER_NOW, ...launchTrust(values),
  }), /PID binding/);
});

test("height updates are role-bound, ordered, monotonic, and independently height-expiring", () => {
  const values = setup(); const start = values.context.checkpoint.height;
  const first = createValidatorReadinessHeightUpdate({
    bootstrap: values.consensusSignerBootstrap, height: start,
  }, { now: READINESS_SIGNER_NOW });
  const second = createValidatorReadinessHeightUpdate({
    bootstrap: values.consensusSignerBootstrap, height: start + 1, previousUpdate: first,
  }, { now: READINESS_SIGNER_NOW });
  const third = createValidatorReadinessHeightUpdate({
    bootstrap: values.consensusSignerBootstrap, height: start + 1, previousUpdate: second,
  }, { now: READINESS_SIGNER_NOW });
  assert.equal(verifyValidatorReadinessHeightUpdate(third, {
    bootstrap: values.consensusSignerBootstrap, expectedRole: "consensus",
    now: READINESS_SIGNER_NOW, previousUpdate: second, ...launchTrust(values),
  }).sequence, 3);
  assert.throws(() => verifyValidatorReadinessHeightUpdate(second, {
    bootstrap: values.consensusSignerBootstrap, expectedRole: "consensus",
    now: READINESS_SIGNER_NOW, previousUpdate: second, ...launchTrust(values),
  }));
  assert.throws(() => createValidatorReadinessHeightUpdate({
    bootstrap: values.consensusSignerBootstrap, height: start, previousUpdate: second,
  }, { now: READINESS_SIGNER_NOW }));
  assert.throws(() => createValidatorReadinessHeightUpdate({
    bootstrap: values.consensusSignerBootstrap,
    height: values.session.expiresAtHeight, previousUpdate: second,
  }, { now: READINESS_SIGNER_NOW }));
  assert.throws(() => verifyValidatorReadinessHeightUpdate(first, {
    bootstrap: values.consensusSignerBootstrap, expectedRole: "consensus",
    now: values.session.expiresAt, ...launchTrust(values),
  }));
  assert.throws(() => verifyValidatorReadinessHeightUpdate(first, {
    bootstrap: values.transportSignerBootstrap, expectedRole: "transport",
    now: READINESS_SIGNER_NOW, ...launchTrust(values),
  }));
  const selfReferential = structuredClone(second);
  selfReferential.predecessorHash = selfReferential.updateHash;
  assert.throws(() => verifyValidatorReadinessHeightUpdate(selfReferential, {
    bootstrap: values.consensusSignerBootstrap, expectedRole: "consensus",
    now: READINESS_SIGNER_NOW, previousUpdate: first, ...launchTrust(values),
  }));
});

test("READY proofs require the pinned role key and fresh process identity", () => {
  const values = setup();
  const first = createValidatorReadinessSignerReady({
    bootstrap: values.consensusSignerBootstrap, pid: 1234, wallet: values.candidate,
  }, { now: READINESS_SIGNER_NOW });
  const second = createValidatorReadinessSignerReady({
    bootstrap: values.consensusSignerBootstrap, pid: 1234, wallet: values.candidate,
  }, { now: READINESS_SIGNER_NOW });
  assert.notEqual(first.processNonce, second.processNonce);
  assert.deepEqual(verifyValidatorReadinessSignerReady(first, {
    bootstrap: values.consensusSignerBootstrap, expectedRole: "consensus",
    now: READINESS_SIGNER_NOW, expectedPid: 1234, ...launchTrust(values),
  }), first);
  assert.throws(() => createValidatorReadinessSignerReady({
    bootstrap: values.consensusSignerBootstrap, pid: 1234, wallet: values.transport,
  }, { now: READINESS_SIGNER_NOW }));
  for (const mutate of [
    (copy) => { copy.pid += 1; },
    (copy) => { copy.processNonce = "0".repeat(64); },
    (copy) => { copy.vaultHash = "sha3-256:" + "0".repeat(64); },
    (copy) => { copy.role = "transport"; },
    (copy) => { copy.extra = true; },
  ]) {
    const changed = structuredClone(first); mutate(changed);
    assert.throws(() => verifyValidatorReadinessSignerReady(changed, {
      bootstrap: values.consensusSignerBootstrap, expectedRole: "consensus",
      now: READINESS_SIGNER_NOW, expectedPid: 1234, ...launchTrust(values),
    }));
  }
});

test("the portable bootstrap layer has no process, vault-opening, filesystem, or environment access", () => {
  assert.doesNotMatch(SOURCE,
    /node:(?:child_process|cluster|fs|net|tls)|\b(?:spawn|fork|execFile|process\.env|decryptWallet)\b/u);
});
