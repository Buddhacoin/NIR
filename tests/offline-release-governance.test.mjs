import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson, generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createOfflineReleaseBundle } from "../blockchain/offline-release-bundle.mjs";
import {
  acceptReleaseAuthorityChange, appendReleaseTransparencyEntry, approveReleaseActivationProposal,
  approveReleaseLogProposal, contextForReleaseLog,
  createReleaseAuthoritySet, createReleaseProposal, createReleaseTransparencyAnchor,
  loadReleaseTransparencyLog, recoverReleaseTransparencyCheckpoint, serializeReleaseGovernance,
  validateReleaseAuthoritySet,
} from "../blockchain/offline-release-governance.mjs";

const REVISION = "a".repeat(40);

function authoritySet(wallets, generation = 1, threshold = 3) {
  return createReleaseAuthoritySet({
    authorities: wallets.map((wallet, index) => ({
      ...publicWallet(wallet), operatorId: `operator-${index + 1}`,
    })),
    generation, rotationDelayEntries: 2, threshold,
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-release-governance-"));
  const source = join(root, "source");
  const log = join(root, "log");
  const checkpoints = join(root, "checkpoints");
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(log, { mode: 0o700 });
  mkdirSync(checkpoints, { mode: 0o700 });
  writeFileSync(join(source, "README.md"), "governed offline release\n");
  const wallets = Array.from({ length: 5 }, generateWallet);
  const set = authoritySet(wallets.slice(0, 4));
  const anchor = createReleaseTransparencyAnchor({
    initialSet: set, logId: "nir-main-releases", networkId: "nir-release-test",
  });
  return { anchor, checkpoints, log, root, set, source, wallets };
}

function bundle(values, version, previousBundleHash = null) {
  return createOfflineReleaseBundle(values.source, ["README.md"], {
    networkId: values.anchor.networkId, previousBundleHash, protocolVersion: 24,
    releaseVersion: version, sourceRevision: REVISION,
  });
}

function approvals(values, proposal, signers = values.wallets.slice(0, 3), state = undefined) {
  const current = state ?? loadReleaseTransparencyLog(values.anchor, values.log, values.checkpoints);
  const context = contextForReleaseLog(values.anchor, current);
  return signers.map((wallet) => {
    const authority = context.currentSet.authorities.find((item) => item.address === wallet.address);
    return approveReleaseLogProposal(proposal, context, { operatorId: authority.operatorId, wallet });
  });
}

function appendRelease(values, version, previousBundleHash = null, signers) {
  const state = loadReleaseTransparencyLog(values.anchor, values.log, values.checkpoints);
  const proposal = createReleaseProposal({
    anchor: values.anchor, bundle: bundle(values, version, previousBundleHash), state,
  });
  return appendReleaseTransparencyEntry({
    anchor: values.anchor, approvals: approvals(values, proposal, signers, state),
    checkpointDirectory: values.checkpoints, logDirectory: values.log, proposal,
  });
}

function cleanup(values) {
  rmSync(values.root, { force: true, recursive: true });
}

test("M-of-N approvals append a release and persist an externally checkable checkpoint", () => {
  const values = fixture();
  try {
    const result = appendRelease(values, "1.0.0");
    assert.equal(result.state.sequence, 1);
    assert.equal(result.state.lastBundleHash, result.entry.payload.bundleHash);
    assert.equal(readdirSync(values.log).length, 1);
    assert.equal(readdirSync(values.checkpoints).length, 1);
    const restored = loadReleaseTransparencyLog(values.anchor, values.log, values.checkpoints);
    assert.deepEqual(restored, result.state);
  } finally { cleanup(values); }
});

test("duplicate, insufficient, stale, replayed and self-authorized approvals fail closed", () => {
  const values = fixture();
  try {
    const state = loadReleaseTransparencyLog(values.anchor, values.log, values.checkpoints);
    const proposal = createReleaseProposal({ anchor: values.anchor, bundle: bundle(values, "1.0.0"), state });
    const signed = approvals(values, proposal, undefined, state);
    assert.throws(() => appendReleaseTransparencyEntry({
      anchor: values.anchor, approvals: signed.slice(0, 2), checkpointDirectory: values.checkpoints,
      logDirectory: values.log, proposal,
    }), /quorum|threshold/);
    assert.throws(() => appendReleaseTransparencyEntry({
      anchor: values.anchor, approvals: [signed[0], signed[0], signed[1]],
      checkpointDirectory: values.checkpoints, logDirectory: values.log, proposal,
    }), /duplicate/);
    appendReleaseTransparencyEntry({ anchor: values.anchor, approvals: signed,
      checkpointDirectory: values.checkpoints, logDirectory: values.log, proposal });
    assert.throws(() => appendReleaseTransparencyEntry({ anchor: values.anchor, approvals: signed,
      checkpointDirectory: values.checkpoints, logDirectory: values.log, proposal }), /stale|context/);

    const nextWallets = [values.wallets[0], values.wallets[1], values.wallets[2], values.wallets[4]];
    const nextSet = authoritySet(nextWallets, 2);
    const afterRelease = loadReleaseTransparencyLog(values.anchor, values.log, values.checkpoints);
    const change = createReleaseProposal({ anchor: values.anchor, nextSet, reason: "rotation", state: afterRelease });
    const nextContext = { currentSet: nextSet, pendingChange: null,
      state: { ...afterRelease, activeSet: nextSet } };
    assert.throws(() => approveReleaseLogProposal(change, nextContext, {
      operatorId: "operator-1", wallet: nextWallets[0],
    }), /stale|context/);
  } finally { cleanup(values); }
});

test("authority rotation is old-quorum authorized, delayed, overlapping, and activates exactly", () => {
  const values = fixture();
  try {
    const nextWallets = [values.wallets[0], values.wallets[1], values.wallets[2], values.wallets[4]];
    const nextSet = authoritySet(nextWallets, 2);
    const state0 = loadReleaseTransparencyLog(values.anchor, values.log, values.checkpoints);
    const change = createReleaseProposal({ anchor: values.anchor, nextSet, reason: "rotation", state: state0 });
    assert.equal(change.payload.activationSequence, 3);
    const nextSetAcceptances = nextWallets.slice(0, 3).map((wallet) => {
      const authority = nextSet.authorities.find((item) => item.address === wallet.address);
      return acceptReleaseAuthorityChange(change, contextForReleaseLog(values.anchor, state0), {
        operatorId: authority.operatorId, wallet,
      });
    });
    appendReleaseTransparencyEntry({ anchor: values.anchor,
      approvals: approvals(values, change, values.wallets.slice(0, 3), state0),
      checkpointDirectory: values.checkpoints, logDirectory: values.log,
      nextSetAcceptances, proposal: change });

    const first = appendRelease(values, "1.0.0");
    assert.equal(first.state.activeSet.setId, values.set.setId);
    const state2 = first.state;
    const release2 = createReleaseProposal({ anchor: values.anchor,
      bundle: bundle(values, "1.0.1", first.state.lastBundleHash), state: state2 });
    const context2 = contextForReleaseLog(values.anchor, state2);
    assert.equal(context2.currentSet.setId, nextSet.setId);
    assert.throws(() => approveReleaseLogProposal(release2, context2, {
      operatorId: "operator-4", wallet: values.wallets[3],
    }), /not an authority/);
    const nextApprovals = nextWallets.slice(0, 3).map((wallet) => {
      const authority = nextSet.authorities.find((item) => item.address === wallet.address);
      return approveReleaseLogProposal(release2, context2, { operatorId: authority.operatorId, wallet });
    });
    const activationApprovals = values.wallets.slice(0, 3).map((wallet) => {
      const authority = values.set.authorities.find((item) => item.address === wallet.address);
      return approveReleaseActivationProposal(release2, context2, { operatorId: authority.operatorId, wallet });
    });
    assert.throws(() => appendReleaseTransparencyEntry({ anchor: values.anchor, approvals: nextApprovals,
      checkpointDirectory: values.checkpoints, logDirectory: values.log, proposal: release2 }),
    /quorum/);
    const activated = appendReleaseTransparencyEntry({ activationApprovals, anchor: values.anchor,
      approvals: nextApprovals, checkpointDirectory: values.checkpoints,
      logDirectory: values.log, proposal: release2 });
    assert.equal(activated.state.activeSet.setId, nextSet.setId);
    assert.equal(activated.state.sequence, 3);

    const insufficientOverlap = authoritySet([
      values.wallets[0], ...Array.from({ length: 3 }, generateWallet),
    ], 3);
    assert.throws(() => createReleaseProposal({ anchor: values.anchor, nextSet: insufficientOverlap,
      reason: "rotation", state: activated.state }), /overlap/);
  } finally { cleanup(values); }
});

test("unavailable next keys cannot be scheduled and checkpoint recovery is idempotent", () => {
  const values = fixture();
  try {
    const nextWallets = [values.wallets[0], values.wallets[1], values.wallets[2], values.wallets[4]];
    const nextSet = authoritySet(nextWallets, 2);
    const state = loadReleaseTransparencyLog(values.anchor, values.log, values.checkpoints);
    const change = createReleaseProposal({ anchor: values.anchor, nextSet, reason: "rotation", state });
    assert.throws(() => appendReleaseTransparencyEntry({ anchor: values.anchor,
      approvals: approvals(values, change, undefined, state), checkpointDirectory: values.checkpoints,
      logDirectory: values.log, proposal: change }), /quorum/);

    const release = appendRelease(values, "1.0.0");
    rmSync(join(values.checkpoints, readdirSync(values.checkpoints)[0]));
    const recovered = recoverReleaseTransparencyCheckpoint({ anchor: values.anchor,
      checkpointDirectory: values.checkpoints, logDirectory: values.log });
    assert.equal(recovered.entryHash, release.entry.entryHash);
    const second = recoverReleaseTransparencyCheckpoint({ anchor: values.anchor,
      checkpointDirectory: values.checkpoints, logDirectory: values.log });
    assert.equal(second.checkpointHash, recovered.checkpointHash);
    assert.equal(readdirSync(values.checkpoints).length, 1);
  } finally { cleanup(values); }
});

test("forked logs, rollback, checkpoint tampering, unknown fields, links, and unsafe roots reject", () => {
  const variants = ["split", "rollback", "checkpoint", "unknown", "hardlink", "symlink-root"];
  for (const variant of variants) {
    const values = fixture();
    try {
      const first = appendRelease(values, "1.0.0");
      if (variant === "split") {
        const source = join(values.log, readdirSync(values.log)[0]);
        linkSync(source, join(values.log, `000000000001-${"f".repeat(64)}.json`));
      } else if (variant === "rollback") {
        rmSync(join(values.log, readdirSync(values.log)[0]));
      } else if (variant === "checkpoint") {
        const path = join(values.checkpoints, readdirSync(values.checkpoints)[0]);
        const value = JSON.parse(readFileSync(path, "utf8"));
        value.entryHash = `sha3-256:${"f".repeat(64)}`;
        writeFileSync(path, `${canonicalJson(value)}\n`);
      } else if (variant === "unknown") {
        const path = join(values.log, readdirSync(values.log)[0]);
        const value = JSON.parse(readFileSync(path, "utf8"));
        value.untrusted = true;
        writeFileSync(path, `${canonicalJson(value)}\n`);
      } else if (variant === "hardlink") {
        const path = join(values.log, readdirSync(values.log)[0]);
        linkSync(path, join(values.root, "second-link"));
      } else {
        const original = `${values.log}-original`;
        renameSync(values.log, original);
        symlinkSync(original, values.log);
      }
      assert.throws(() => loadReleaseTransparencyLog(values.anchor, values.log, values.checkpoints),
        /split|duplicate|rolled back|forked|invalid|unknown|unsafe/);
      assert.equal(first.state.sequence, 1);
    } finally { cleanup(values); }
  }
});

test("schemas reject duplicate authority identity, invalid revocation, and unknown fields", () => {
  const values = fixture();
  try {
    const duplicated = values.set.authorities.map((item) => ({ ...item }));
    duplicated[1].operatorId = duplicated[0].operatorId;
    assert.throws(() => createReleaseAuthoritySet({ authorities: duplicated, generation: 2,
      rotationDelayEntries: 2, threshold: 3 }), /duplicate|ordered/);
    assert.throws(() => validateReleaseAuthoritySet({ ...values.set, extra: true }), /unknown/);
    const sameAuthorities = createReleaseAuthoritySet({ authorities: values.set.authorities,
      generation: 2, rotationDelayEntries: 2, threshold: 3 });
    assert.throws(() => createReleaseProposal({ anchor: values.anchor, nextSet: sameAuthorities,
      reason: "revocation", state: loadReleaseTransparencyLog(values.anchor, values.log, values.checkpoints) }),
    /does not revoke/);
  } finally { cleanup(values); }
});

test("CLI verify binds the local log head to an explicit external sequence and hash", () => {
  const values = fixture();
  try {
    const first = appendRelease(values, "1.0.0");
    const anchorPath = join(values.root, "anchor.json");
    writeFileSync(anchorPath, serializeReleaseGovernance(values.anchor), { mode: 0o600 });
    const output = execFileSync(process.execPath, ["blockchain/offline-release-governance-cli.mjs",
      "verify", anchorPath, values.log, values.checkpoints, "1", first.entry.entryHash], {
      cwd: new URL("..", import.meta.url), encoding: "utf8",
    });
    assert.match(output, /verified at 1/);
    assert.throws(() => execFileSync(process.execPath,
      ["blockchain/offline-release-governance-cli.mjs", "verify", anchorPath, values.log,
        values.checkpoints, "0", values.anchor.anchorHash], {
        cwd: new URL("..", import.meta.url), encoding: "utf8", stdio: "pipe",
      }), /Command failed/);
  } finally { cleanup(values); }
});
