import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildMacWallet } from "../blockchain/wallet-macos-build.mjs";
import { createWalletPreviewServer } from "../blockchain/wallet-preview-cli.mjs";

test("local wallet bundle uses a strict source allowlist and refuses secret-named paths", () => {
  const source = readFileSync(new URL("../blockchain/wallet-macos-build.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /cpSync\(/);
  assert.match(source, /const PACKAGE_FILES = Object\.freeze/);
  assert.match(source, /rejectSecretPaths\(\)/);
  const app = readFileSync(new URL("../blockchain/wallet-macos-app.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(app, /wallet-mining-practice|wallet-macos-local-update|wallet-sync/);
  const secret = new URL("../blockchain/pr3-fixture.nirvault.json", import.meta.url).pathname;
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-secret-rejection-"));
  try {
    writeFileSync(secret, "fixture, not a key\n", { flag: "wx" });
    assert.throws(() => buildMacWallet(join(directory, "NIR Wallet.app"), { sign: false }),
      /secret-named path/);
  } finally { unlinkSync(secret); rmSync(directory, { recursive: true, force: true }); }
});

test("macOS wallet package includes code, UI, demo policy, and icon without overwriting", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-build-test-"));
  try {
    const app = join(directory, "NIR Wallet.app");
    assert.equal(buildMacWallet(app, { sign: false }), app);
    for (const relative of [
      "Contents/Info.plist", "Contents/MacOS/launcher", "Contents/MacOS/onboarding",
      "Contents/Resources/NIR.icns",
      "Contents/Resources/NIR-LOCAL-BUILD.json",
      "Contents/Resources/NIR-RUNTIME.json",
      "Contents/Resources/app/package.json",
      "Contents/Resources/app/blockchain/wallet-macos-app.mjs",
      "Contents/Resources/app/blockchain/wallet-preview-cli.mjs",
      "Contents/Resources/app/blockchain/wallet-macos-setup.mjs",
      "Contents/Resources/app/demo/wallet-nodes.local-demo.json",
      "Contents/Resources/app/wallet-ui/index.html",
      "Contents/Resources/app/wallet-ui/nir-coin-icon.png",
    ]) assert.equal(existsSync(join(app, relative)), true, relative);
    for (const relative of ["Contents/Resources/app/blockchain/wallet-macos-local-update.mjs",
      "Contents/Resources/app/blockchain/wallet-mining-practice.mjs",
      "Contents/Resources/app/blockchain/wallet-sync-envelope.mjs"]) {
      assert.equal(existsSync(join(app, relative)), false, relative);
    }
    const launcher = readFileSync(new URL("../macos/wallet-launcher.m", import.meta.url), "utf8");
    assert.deepEqual(JSON.parse(readFileSync(join(app, "Contents/Resources/NIR-RUNTIME.json"))),
      { nodeExecutable: process.execPath });
    const info = readFileSync(join(app, "Contents/Info.plist"), "utf8");
    assert.match(info, /<key>CFBundleShortVersionString<\/key><string>0\.2\.0<\/string>/);
    assert.match(launcher, /app\/blockchain\/wallet-macos-app\.mjs/);
    assert.match(launcher, /\[app run\]/);
    assert.doesNotMatch(launcher, /\.\.\/\.\.\/\.\.\/\.\./);
    const nativeSource = readFileSync(new URL("../macos/wallet-onboarding.m", import.meta.url), "utf8");
    assert.match(nativeSource, /self\.backupMenu\.hidden = !restoring/);
    assert.match(nativeSource, /if \(!\[\[self mode\] isEqualToString:@"restore"\]\) return;/);
    assert.match(nativeSource, /self\.submitted = YES;\s*\[NSApp terminate:nil\]/);
    assert.match(nativeSource, /if \(!self\.submitted\) exit\(2\)/);
    assert.match(nativeSource, /pairingWindow\.level = NSFloatingWindowLevel/);
    assert.match(nativeSource, /NSWindowCollectionBehaviorMoveToActiveSpace/);
    const renewal = nativeSource.match(/self\.renewButton\.frame = NSMakeRect\(28, (\d+), 334, (\d+)\)/);
    const addressLabel = nativeSource.match(/self\.pathLabel\.frame = NSMakeRect\(28, (\d+), 334, (\d+)\)/);
    const openingPassword = nativeSource.match(/self\.password\.frame = opening \? NSMakeRect\(28, (\d+), 334, (\d+)\)/);
    assert.ok(renewal && addressLabel && openingPassword);
    assert.ok(Number(renewal[1]) >= Number(addressLabel[1]) + Number(addressLabel[2]));
    assert.ok(Number(renewal[1]) + Number(renewal[2]) <= Number(openingPassword[1]));
    assert.throws(() => buildMacWallet(app, { sign: false }), /new NIR Wallet\.app/);
    const linkDir = join(directory, "other");
    mkdirSync(linkDir);
    const dangling = join(linkDir, "NIR Wallet.app");
    symlinkSync(join(directory, "missing-app"), dangling);
    assert.throws(() => buildMacWallet(dangling, { sign: false }), /new NIR Wallet\.app/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native app uses a fresh UI origin and disables persistent service-worker caching", async () => {
  const native = readFileSync(new URL("../blockchain/wallet-macos-app.mjs", import.meta.url), "utf8");
  const browser = readFileSync(new URL("../wallet-ui/app.js", import.meta.url), "utf8");
  assert.match(native, /await listen\(ui, 0\)/);
  assert.match(native, /local-demo=1&local-app=1/);
  assert.match(browser, /get\("local-app"\) === "1"/);
  assert.match(browser, /entry\.unregister\(\)/);
  const server = createWalletPreviewServer();
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/?local-demo=1&local-app=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await closed;
  }
});

test("native onboarding submits a selection instead of silently treating it as cancel", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-native-smoke-"));
  try {
    const binary = join(directory, "onboarding-smoke");
    const source = new URL("../macos/wallet-onboarding.m", import.meta.url).pathname;
    const built = spawnSync("/usr/bin/clang", ["-fobjc-arc", "-DNIR_ONBOARDING_SMOKE_TEST",
      "-framework", "AppKit", "-framework", "Foundation", source, "-o", binary],
    { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { mode: "create", password: "test-only-123" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native restore submits backup, recovery code, address, and new password", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-native-restore-"));
  try {
    const binary = join(directory, "onboarding-restore-smoke");
    const source = new URL("../macos/wallet-onboarding.m", import.meta.url).pathname;
    const built = spawnSync("/usr/bin/clang", ["-fobjc-arc",
      "-DNIR_ONBOARDING_SMOKE_RESTORE_TEST", "-framework", "AppKit", "-framework",
      "Foundation", source, "-o", binary], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 0, run.stderr);
    const selection = JSON.parse(run.stdout);
    assert.equal(selection.mode, "restore");
    assert.equal(selection.path, "/tmp/test-backup.nirvault.json");
    assert.equal(selection.newPassword, "new-test-123");
    assert.match(selection.recoveryCode, /^ABCDE-/);
    assert.match(selection.address, /^nir1a{64}$/);
    assert.equal(Object.hasOwn(selection, "password"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native opening selects an account by address without a file chooser", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-native-open-"));
  try {
    const binary = join(directory, "onboarding-open-smoke");
    const source = new URL("../macos/wallet-onboarding.m", import.meta.url).pathname;
    const built = spawnSync("/usr/bin/clang", ["-fobjc-arc",
      "-DNIR_ONBOARDING_SMOKE_OPEN_TEST", "-framework", "AppKit", "-framework",
      "Foundation", source, "-o", binary], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const wallets = [
      { address: `nir1${"a".repeat(64)}`, path: "/tmp/account-one.nirvault.json" },
      { address: `nir1${"b".repeat(64)}`, path: "/tmp/account-two.nirvault.json" },
    ];
    const run = spawnSync(binary, [], { input: JSON.stringify({ wallets,
      preferredPath: wallets[1].path }),
      encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { mode: "open", path: wallets[1].path,
      password: "selected-account-test-password" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native opening can request a replacement recovery code with the selected vault password", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-native-renew-"));
  try {
    const binary = join(directory, "onboarding-renew-smoke");
    const source = new URL("../macos/wallet-onboarding.m", import.meta.url).pathname;
    const built = spawnSync("/usr/bin/clang", ["-fobjc-arc",
      "-DNIR_ONBOARDING_SMOKE_RENEW_TEST", "-framework", "AppKit", "-framework",
      "Foundation", source, "-o", binary], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const vault = { address: `nir1${"a".repeat(64)}`,
      path: "/tmp/account-one.nirvault.json" };
    const run = spawnSync(binary, [], { input: JSON.stringify({ wallets: [vault] }),
      encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { mode: "renew", path: vault.path,
      password: "selected-account-test-password" });
    const nativeSource = readFileSync(source, "utf8");
    assert.match(nativeSource, /Старые копия и код продолжат работать/);
    assert.match(nativeSource, /создайте новый адрес и переведите на него средства/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
