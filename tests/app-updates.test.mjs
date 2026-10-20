import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createKey, pinnedSignerInSource, signRelease } from "../blockchain/app-release-cli.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import { createSourceRelease, SOURCE_RELEASE_PATH, verifySourceRelease } from "../blockchain/source-release.mjs";
import { buildUpdateRecord, readUpdateRecord, SourceUpdater, startSwap } from "../blockchain/source-updater.mjs";

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const ANCHOR = 'export const pinnedUpdateSignerAddress = null;\n';
const PASSWORD = "release key password 2026";

// An origin repository, the owner's checkout, and the user's checkout on the
// Mac that the installed app was built from.
function repositories() {
  const directory = mkdtempSync(join(tmpdir(), "nir-app-update-"));
  const origin = join(directory, "origin.git");
  const owner = join(directory, "owner");
  const mac = join(directory, "mac");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["clone", "--quiet", origin, owner], { stdio: "ignore" });
  for (const repo of [owner]) {
    git(repo, "config", "user.email", "owner@example.invalid");
    git(repo, "config", "user.name", "Owner");
  }
  mkdirSync(join(owner, "blockchain"));
  writeFileSync(join(owner, "blockchain", "update-trust-anchor.mjs"), ANCHOR);
  writeFileSync(join(owner, "package.json"), '{"version":"0.2.0"}\n');
  writeFileSync(join(owner, "app.txt"), "first\n");
  git(owner, "add", ".");
  git(owner, "commit", "--quiet", "-m", "first");
  git(owner, "push", "--quiet", "origin", "HEAD:main");
  execFileSync("git", ["clone", "--quiet", origin, mac], { stdio: "ignore" });
  return { directory, mac, origin, owner };
}

test("a source release verifies only under the pinned signer and exact fields", () => {
  const owner = generateWallet();
  const envelope = createSourceRelease({ wallet: owner, sequence: 3, sourceRevision: "a".repeat(40),
    version: "0.3.0" });
  assert.deepEqual(verifySourceRelease(envelope, { trustedAddress: owner.address }),
    { format: "nir-source-release-v1", sequence: 3, sourceRevision: "a".repeat(40), version: "0.3.0" });
  assert.throws(() => verifySourceRelease(envelope, { trustedAddress: null }), /no release signer is pinned/);
  assert.throws(() => verifySourceRelease(envelope, { trustedAddress: generateWallet().address }), /not trusted/);
  const altered = structuredClone(envelope);
  altered.release.sourceRevision = "b".repeat(40);
  assert.throws(() => verifySourceRelease(altered, { trustedAddress: owner.address }), /signature is invalid/);
  const extra = structuredClone(envelope);
  extra.release.url = "https://example.invalid";
  assert.throws(() => verifySourceRelease(extra, { trustedAddress: owner.address }), /source release is invalid/);
});

test("the owner pins a key, signs main, and the app updates to exactly that commit", async () => {
  const { directory, mac, owner } = repositories();
  process.env.NIR_RELEASE_PASSWORD = PASSWORD;
  try {
    const keyPath = join(directory, "keys", "release.nirvault.json");
    await createKey(keyPath, owner);
    const signer = pinnedSignerInSource(owner);
    assert.match(signer, /^nir1[0-9a-f]{64}$/);
    await assert.rejects(createKey(join(directory, "other.json"), owner), /already pinned/);
    // An uncommitted pin cannot be released.
    await assert.rejects(signRelease(keyPath, owner), /commit or discard/);
    git(owner, "commit", "--quiet", "-am", "Pin release key");
    git(owner, "push", "--quiet", "origin", "HEAD:main");

    // The installed app was built from the user's checkout before the release.
    const record = buildUpdateRecord({ product: "model-lab", root: mac, env: {} });
    assert.equal(record.sourceRevision, git(mac, "rev-parse", "HEAD"));
    assert.equal(record.releaseSequence, 0);
    let built = null;
    let restarted = null;
    const updater = new SourceUpdater({
      appPath: join(directory, "Apps", "NIR Model Lab.app"), record, trustedAddress: signer,
      build: async (source, target, release) => {
        built = { release, text: readFileSync(join(source, "app.txt"), "utf8") };
        mkdirSync(target);
      },
      restart: (paths) => { restarted = paths; },
    });
    mkdirSync(join(directory, "Apps", "NIR Model Lab.app"), { recursive: true });
    assert.equal((await updater.check()).release, null);

    writeFileSync(join(owner, "app.txt"), "second\n");
    git(owner, "commit", "--quiet", "-am", "second");
    git(owner, "push", "--quiet", "origin", "HEAD:main");
    const released = git(owner, "rev-parse", "HEAD");
    assert.match(await signRelease(keyPath, owner), /sequence 1/);
    await assert.rejects(signRelease(keyPath, owner), /already released/);

    const status = await updater.check();
    assert.equal(status.available, true);
    assert.deepEqual(status.release, { sequence: 1, version: "0.2.0" });
    // Work in the user's checkout is untouched by checking or updating.
    writeFileSync(join(mac, "local-note.txt"), "mine\n");
    await updater.apply();
    assert.equal(built.text, "second\n");
    assert.equal(built.release.sourceRevision, released);
    assert.equal(updater.status().state, "restarting");
    assert.equal(restarted.appPath, join(directory, "Apps", "NIR Model Lab.app"));
    assert.ok(existsSync(restarted.stagedAppPath));
    assert.equal(readFileSync(join(mac, "app.txt"), "utf8"), "first\n");
    assert.equal(readFileSync(join(mac, "local-note.txt"), "utf8"), "mine\n");
    // The next real change is the next release.
    writeFileSync(join(owner, "app.txt"), "third\n");
    git(owner, "commit", "--quiet", "-am", "third");
    git(owner, "push", "--quiet", "origin", "HEAD:main");
    assert.match(await signRelease(keyPath, owner), /sequence 2/);
  } finally {
    delete process.env.NIR_RELEASE_PASSWORD;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("releases by another key, replays, and unknown commits are refused", async () => {
  const { directory, mac, owner } = repositories();
  try {
    const trusted = generateWallet();
    const record = { builderNode: process.execPath, format: "nir-app-update-record-v1", product: "wallet",
      releaseSequence: 4, sourceRevision: git(mac, "rev-parse", "HEAD"), sourceRoot: mac };
    const publish = (envelope) => {
      mkdirSync(join(owner, "releases"), { recursive: true });
      writeFileSync(join(owner, SOURCE_RELEASE_PATH), JSON.stringify(envelope));
      git(owner, "add", ".");
      git(owner, "commit", "--quiet", "-m", "release");
      git(owner, "push", "--quiet", "origin", "HEAD:main");
    };
    const head = git(owner, "rev-parse", "HEAD");
    let builds = 0;
    const updater = new SourceUpdater({ appPath: join(directory, "NIR Wallet.app"), record,
      trustedAddress: trusted.address, build: async () => { builds++; }, restart: () => {} });

    publish(createSourceRelease({ wallet: generateWallet(), sequence: 9, sourceRevision: head, version: "1.0.0" }));
    const forged = await updater.check();
    assert.equal(forged.state, "failed");
    assert.match(forged.error, /not trusted/);

    // An older release than the installed one is not offered.
    publish(createSourceRelease({ wallet: trusted, sequence: 4, sourceRevision: head, version: "1.0.0" }));
    assert.equal((await updater.check()).available, false);
    await assert.rejects(updater.apply(), /no newer signed release/);

    // A signed commit that main does not contain is refused before building.
    publish(createSourceRelease({ wallet: trusted, sequence: 5, sourceRevision: "c".repeat(40), version: "1.0.0" }));
    assert.equal((await updater.check()).available, true);
    await assert.rejects(updater.apply());
    assert.equal(builds, 0);

    // No pinned key, or no checkout: updates are off and say why.
    const unsigned = new SourceUpdater({ appPath: join(directory, "NIR Wallet.app"), record,
      trustedAddress: null, build: async () => {}, restart: () => {} });
    assert.equal((await unsigned.check()).error, "no-release-signer");
    const noCheckout = new SourceUpdater({ appPath: join(directory, "NIR Wallet.app"),
      record: { ...record, sourceRoot: null }, trustedAddress: trusted.address, build: async () => {},
      restart: () => {} });
    assert.equal((await noCheckout.check()).error, "no-source-checkout");
    assert.throws(() => readUpdateRecord(join(directory, "missing.json")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the swap waits for the app to quit, keeps the previous app, and reopens", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-app-swap-"));
  try {
    const target = join(directory, "NIR Wallet.app");
    const staged = join(directory, ".nir-update-x", "NIR Wallet.app");
    const backup = join(directory, ".nir-update-x", "previous NIR Wallet.app");
    mkdirSync(target);
    writeFileSync(join(target, "version"), "old");
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, "version"), "new");
    const opened = join(directory, "opened");
    const opener = join(directory, "open.sh");
    writeFileSync(opener, `#!/bin/sh\necho "$1" > "${opened}"\n`, { mode: 0o755 });
    const app = spawn("sleep", ["30"]);
    let signalled = null;
    startSwap({ appPath: target, backupPath: backup, launcherPid: app.pid, opener, stagedAppPath: staged,
      signal: (pid) => { signalled = pid; setTimeout(() => app.kill(), 200); } });
    assert.equal(signalled, app.pid);
    // Nothing moves while the app is still running.
    assert.equal(readFileSync(join(target, "version"), "utf8"), "old");
    const deadline = Date.now() + 10_000;
    while (!existsSync(opened) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(readFileSync(opened, "utf8").trim(), target);
    assert.equal(readFileSync(join(target, "version"), "utf8"), "new");
    assert.equal(readFileSync(join(backup, "version"), "utf8"), "old");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
