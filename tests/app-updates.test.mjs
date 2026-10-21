import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createKey, pinnedSignerInSource, signRelease } from "../blockchain/app-release-cli.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import { createSourceRelease, verifySourceRelease } from "../blockchain/source-release.mjs";
import { buildUpdateRecord, macLauncherPid, readUpdateRecord, removePreviousVersions, SourceUpdater, startSwap } from "../blockchain/source-updater.mjs";

function readUpdateRecordFrom(directory, record) {
  const path = join(directory, "NIR-UPDATE.json");
  writeFileSync(path, JSON.stringify(record));
  return readUpdateRecord(path);
}

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

test("the app follows main: it offers newer commits only and builds exactly the newest", async () => {
  const { directory, mac, origin, owner } = repositories();
  try {
    // The installed app was built from the user's checkout of main.
    const record = buildUpdateRecord({ product: "model-lab", root: mac, env: {} });
    assert.equal(record.sourceRevision, git(mac, "rev-parse", "HEAD"));
    assert.deepEqual(readUpdateRecordFrom(directory, record), record);
    let built = null;
    let restarted = null;
    const appPath = join(directory, "Apps", "NIR Model Lab.app");
    mkdirSync(appPath, { recursive: true });
    const updater = new SourceUpdater({
      appPath, record, sourceDirectory: join(directory, "updates", "model-lab.git"), sourceUrl: origin,
      build: async (source, target, release) => {
        built = { release, text: readFileSync(join(source, "app.txt"), "utf8") };
        mkdirSync(target);
      },
      restart: (paths) => { restarted = paths; },
    });
    assert.equal((await updater.check()).available, false);

    writeFileSync(join(owner, "app.txt"), "second\n");
    git(owner, "commit", "--quiet", "-am", "second");
    writeFileSync(join(owner, "app.txt"), "third\n");
    git(owner, "commit", "--quiet", "-am", "third");
    git(owner, "push", "--quiet", "origin", "HEAD:main");
    const newest = git(owner, "rev-parse", "HEAD");
    const status = await updater.check();
    assert.equal(status.available, true);
    assert.equal(status.release.changes, 2);
    assert.equal(status.release.version, "0.2.0");
    assert.equal(status.release.revision, newest.slice(0, 12));
    assert.match(status.release.date, /^\d{4}-\d{2}-\d{2}$/);
    await updater.apply();
    assert.equal(built.text, "third\n");
    assert.equal(built.release.sourceRevision, newest);
    assert.equal(updater.status().state, "restarting");
    assert.equal(restarted.appPath, appPath);
    assert.ok(existsSync(restarted.stagedAppPath));
    // The user's own checkout is never touched.
    assert.equal(readFileSync(join(mac, "app.txt"), "utf8"), "first\n");

    // A build already ahead of main is not offered an older main.
    const ahead = new SourceUpdater({ appPath, record: { ...record, sourceRevision: newest },
      sourceDirectory: join(directory, "updates", "model-lab.git"), sourceUrl: origin,
      build: async () => assert.fail("must not build"), restart: () => {} });
    assert.equal((await ahead.check()).available, false);
    await assert.rejects(ahead.apply(), /no newer version/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a build without an update record says it must be rebuilt once", async () => {
  const updater = new SourceUpdater({ appPath: "/Applications/NIR Wallet.app", record: null,
    sourceDirectory: "/nonexistent", build: async () => {}, restart: () => {} });
  const status = await updater.check();
  assert.equal(status.error, "not-updatable-build");
  assert.equal(status.available, false);
  await assert.rejects(updater.apply(), /cannot update itself/);
});

test("with a release authority pinned, only its signed releases on main are installed", async () => {
  const { directory, mac, origin, owner } = repositories();
  process.env.NIR_RELEASE_PASSWORD = PASSWORD;
  try {
    const keyPath = join(directory, "keys", "release.nirvault.json");
    await createKey(keyPath, owner);
    const signer = pinnedSignerInSource(owner);
    assert.match(signer, /^nir1[0-9a-f]{64}$/);
    await assert.rejects(createKey(join(directory, "other.json"), owner), /already pinned/);
    await assert.rejects(signRelease(keyPath, owner), /commit or discard/);
    git(owner, "commit", "--quiet", "-am", "Pin release key");
    git(owner, "push", "--quiet", "origin", "HEAD:main");
    const record = buildUpdateRecord({ product: "wallet", root: mac, env: {} });
    let builds = 0;
    const updater = (trustedAddress) => new SourceUpdater({ appPath: join(directory, "NIR Wallet.app"), record,
      sourceDirectory: join(directory, "updates", "wallet.git"), sourceUrl: origin, trustedAddress,
      build: async (source, target) => { builds++; mkdirSync(target); }, restart: () => {} });

    // Unsigned commits on main are not offered.
    assert.equal((await updater(signer).check()).available, false);
    writeFileSync(join(owner, "app.txt"), "second\n");
    git(owner, "commit", "--quiet", "-am", "second");
    git(owner, "push", "--quiet", "origin", "HEAD:main");
    const released = git(owner, "rev-parse", "HEAD");
    assert.match(await signRelease(keyPath, owner), /sequence 1/);
    await assert.rejects(signRelease(keyPath, owner), /already released/);
    // A different authority's app rejects the release.
    const foreign = await updater(generateWallet().address).check();
    assert.equal(foreign.state, "failed");
    assert.match(foreign.error, /not trusted/);
    const status = await updater(signer).check();
    assert.equal(status.available, true);
    assert.equal(status.signed, true);
    assert.equal(status.release.revision, released.slice(0, 12));
    await updater(signer).apply();
    assert.equal(builds, 1);
    writeFileSync(join(owner, "app.txt"), "third\n");
    git(owner, "commit", "--quiet", "-am", "third");
    git(owner, "push", "--quiet", "origin", "HEAD:main");
    assert.match(await signRelease(keyPath, owner), /sequence 2/);
  } finally {
    delete process.env.NIR_RELEASE_PASSWORD;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the swap keeps the app folder, so shortcuts and the Dock open the new version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-app-swap-"));
  try {
    const target = join(directory, "NIR Wallet.app");
    const staged = join(directory, ".nir-update-xY12zW", "NIR Wallet.app");
    const backup = join(directory, ".nir-update-xY12zW", "previous NIR Wallet.app");
    mkdirSync(join(target, "Contents"), { recursive: true });
    writeFileSync(join(target, "Contents", "version"), "old");
    mkdirSync(join(staged, "Contents"), { recursive: true });
    writeFileSync(join(staged, "Contents", "version"), "new");
    // Finder aliases and the Dock follow the folder's identity.
    const identity = statSync(target).ino;
    const opened = join(directory, "opened");
    const opener = join(directory, "open.sh");
    writeFileSync(opener, `#!/bin/sh\necho "$1" > "${opened}"\n`, { mode: 0o755 });
    const app = spawn("sleep", ["30"]);
    let signalled = null;
    startSwap({ appPath: target, backupPath: backup, launcherPid: app.pid, opener, stagedAppPath: staged,
      signal: (pid) => { signalled = pid; setTimeout(() => app.kill(), 200); } });
    assert.equal(signalled, app.pid);
    // Nothing moves while the app is still running.
    assert.equal(readFileSync(join(target, "Contents", "version"), "utf8"), "old");
    const deadline = Date.now() + 10_000;
    while (!existsSync(opened) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(readFileSync(opened, "utf8").trim(), target);
    assert.equal(readFileSync(join(target, "Contents", "version"), "utf8"), "new");
    assert.equal(statSync(target).ino, identity);
    assert.equal(readFileSync(join(backup, "Contents", "version"), "utf8"), "old");
    assert.equal(existsSync(staged), false);
    // The next start of the updated app removes the rollback copy.
    assert.equal(removePreviousVersions(target), 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the launcher is found whether the runner forks Node (miner) or execs it (wallet)", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-launcher-"));
  try {
    const app = "/Applications/NIR Wallet.app";
    // pid: [command, parent]
    const table = { 50: [`${app}/Contents/MacOS/launcher`, 1], 60: [`${app}/Contents/MacOS/mining-runner`, 50],
      1: ["/sbin/launchd", 0], 70: ["/bin/zsh", 1] };
    const ps = join(directory, "ps");
    writeFileSync(ps, `#!/bin/sh
case "$2" in comm=) field=0 ;; *) field=1 ;; esac
case "$4" in
${Object.entries(table).map(([pid, row]) => `  ${pid}) [ $field = 0 ] && echo "${row[0]}" || echo ${row[1]} ;;`).join("\n")}
esac
`, { mode: 0o755 });
    assert.equal(macLauncherPid(app, { ps, parentPid: 50 }), 50);
    assert.equal(macLauncherPid(app, { ps, parentPid: 60 }), 50);
    assert.throws(() => macLauncherPid(app, { ps, parentPid: 70 }), /could not be identified/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a running updated app removes only its own rollback copies", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-previous-"));
  try {
    const wallet = join(directory, "NIR Wallet.app");
    mkdirSync(wallet);
    const own = join(directory, ".nir-update-aB12cD");
    mkdirSync(join(own, "previous NIR Wallet.app"), { recursive: true });
    // The miner's rollback copy and an update still building stay.
    const miner = join(directory, ".nir-update-Ef34Gh");
    mkdirSync(join(miner, "previous NIR Miner.app"), { recursive: true });
    const building = join(directory, ".nir-update-Ij56Kl");
    mkdirSync(join(building, "source"), { recursive: true });
    mkdirSync(join(building, "previous NIR Wallet.app"));
    assert.equal(removePreviousVersions(wallet), 1);
    assert.equal(existsSync(own), false);
    assert.equal(existsSync(miner), true);
    assert.equal(existsSync(building), true);
    assert.equal(existsSync(wallet), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
