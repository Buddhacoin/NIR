import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync,
  renameSync, rmSync, symlinkSync,
  writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { buildMacWallet } from "../blockchain/wallet-macos-build.mjs";
import { inspectLocalMacWallet, installLocalMacWallet } from
  "../blockchain/wallet-macos-local-install.mjs";

test("local Mac update exchanges one pinned app atomically and preserves the previous generation", {
  skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync("/private/tmp/nir-wallet-local-install-");
  const installed = join(root, "installed");
  const staged = join(root, ".staged");
  const target = join(installed, "NIR Wallet.app");
  const candidate = join(staged, "NIR Wallet.app");
  const helper = join(root, "wallet-app-exchange");
  try {
    mkdirSync(installed, { mode: 0o700 });
    mkdirSync(staged, { mode: 0o700 });
    buildMacWallet(candidate);
    cpSync(candidate, target, { recursive: true });
    const oldMarker = join(target, "Contents/Resources/NIR-LOCAL-BUILD.json");
    writeFileSync(oldMarker,
      '{"format":"nir-local-test-build-v1","distribution":"not-a-public-installer"}\n');
    execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", target]);
    execFileSync("/usr/bin/clang", ["-Wall", "-Wextra", "-Werror",
      new URL("../macos/wallet-app-exchange.c", import.meta.url).pathname,
      "-o", helper]);
    const old = inspectLocalMacWallet(target);
    const next = inspectLocalMacWallet(candidate);
    assert.equal(old.sequence, 0);
    assert.equal(next.sequence, 1);
    assert.notEqual(old.hash, next.hash);

    assert.throws(() => installLocalMacWallet({ target, candidate,
      expectedOldHash: "0".repeat(64), expectedNewHash: next.hash,
      exchangeExecutable: helper }), /pins or build sequence/);
    assert.equal(inspectLocalMacWallet(target).hash, old.hash);
    assert.throws(() => installLocalMacWallet({ target, candidate,
      expectedOldHash: old.hash, expectedNewHash: old.hash,
      exchangeExecutable: helper }), /distinct pinned/);

    const result = installLocalMacWallet({ target, candidate,
      expectedOldHash: old.hash, expectedNewHash: next.hash,
      exchangeExecutable: helper });
    assert.equal(result.current, target);
    assert.equal(result.previous, candidate);
    assert.equal(inspectLocalMacWallet(target).hash, next.hash);
    assert.equal(inspectLocalMacWallet(candidate).hash, old.hash);
    assert.throws(() => installLocalMacWallet({ target, candidate,
      expectedOldHash: next.hash, expectedNewHash: old.hash,
      exchangeExecutable: helper }), /pins or build sequence/);

    const staged2 = join(root, ".staged2");
    mkdirSync(staged2, { mode: 0o700 });
    const candidate2 = join(staged2, "NIR Wallet.app");
    cpSync(target, candidate2, { recursive: true });
    writeFileSync(join(candidate2, "Contents/Resources/NIR-LOCAL-BUILD.json"),
      '{"format":"nir-local-test-build-v2","distribution":"not-a-public-installer","sequence":2}\n');
    execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", candidate2]);
    const second = inspectLocalMacWallet(candidate2);
    const flakyHelper = join(root, "exchange-then-error");
    writeFileSync(flakyHelper, `#!/bin/sh\n"${helper}" "$1" "$2"\nexit 1\n`);
    chmodSync(flakyHelper, 0o700);
    assert.throws(() => installLocalMacWallet({ target, candidate: candidate2,
      expectedOldHash: next.hash, expectedNewHash: second.hash,
      exchangeExecutable: flakyHelper }));
    assert.equal(inspectLocalMacWallet(target).hash, next.hash,
      "helper failure after the exchange must restore the original app");
    assert.equal(inspectLocalMacWallet(candidate2).hash, second.hash);
    installLocalMacWallet({ target, candidate: candidate2,
      expectedOldHash: next.hash, expectedNewHash: second.hash,
      exchangeExecutable: helper });
    assert.equal(inspectLocalMacWallet(target).sequence, 2);
    assert.equal(inspectLocalMacWallet(candidate2).hash, next.hash);
    assert.throws(() => installLocalMacWallet({ target, candidate: candidate2,
      expectedOldHash: second.hash, expectedNewHash: next.hash,
      exchangeExecutable: helper }), /pins or build sequence/);

    const ui = join(candidate, "Contents/Resources/app/wallet-ui/app.js");
    writeFileSync(ui, `${readFileSync(ui, "utf8")}\n// tampered\n`);
    assert.throws(() => inspectLocalMacWallet(candidate));
    assert.equal(inspectLocalMacWallet(target).hash, second.hash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local Mac updater refuses a symlinked candidate and never changes the installed app", {
  skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync("/private/tmp/nir-wallet-install-link-");
  const installed = join(root, "installed");
  const staged = join(root, ".staged");
  try {
    mkdirSync(installed, { mode: 0o700 });
    mkdirSync(staged, { mode: 0o700 });
    const target = join(installed, "NIR Wallet.app");
    buildMacWallet(target);
    const before = inspectLocalMacWallet(target);
    const candidate = join(staged, "NIR Wallet.app");
    symlinkSync(target, candidate);
    assert.throws(() => inspectLocalMacWallet(candidate), /unsafe component/);
    assert.equal(inspectLocalMacWallet(target).hash, before.hash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local Mac inspection rejects external Node replacement without app changes", {
  skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync("/private/tmp/nir-wallet-runtime-pin-");
  try {
    const app = join(root, "NIR Wallet.app");
    const runtime = join(root, "node-copy");
    copyFileSync(process.execPath, runtime);
    buildMacWallet(app);
    const manifest = join(app, "Contents/Resources/NIR-RUNTIME.json");
    const original = readFileSync(runtime);
    writeFileSync(manifest, `${JSON.stringify({ nodeExecutable: runtime,
      nodeSha256: createHash("sha256").update(original).digest("hex") })}\n`);
    execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app]);
    const before = inspectLocalMacWallet(app);
    const signedManifest = readFileSync(manifest, "utf8");
    const replacement = join(root, "replacement");
    writeFileSync(replacement, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    renameSync(replacement, runtime);
    assert.throws(() => inspectLocalMacWallet(app), /runtime bytes differ/);
    assert.equal(readFileSync(manifest, "utf8"), signedManifest);
    assert.equal(before.sequence, 1);
    writeFileSync(runtime, "");
    writeFileSync(manifest, `${JSON.stringify({ nodeExecutable: runtime,
      nodeSha256: createHash("sha256").update("").digest("hex") })}\n`);
    execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app]);
    assert.throws(() => inspectLocalMacWallet(app), /runtime is unavailable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy unpinned app needs explicit migration and a pinned new generation", {
  skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync("/private/tmp/nir-wallet-legacy-runtime-");
  try {
    const installed = join(root, "installed");
    const staged = join(root, ".staged");
    mkdirSync(installed, { mode: 0o700 });
    mkdirSync(staged, { mode: 0o700 });
    const target = join(installed, "NIR Wallet.app");
    const candidate = join(staged, "NIR Wallet.app");
    buildMacWallet(target);
    buildMacWallet(candidate);
    const oldRuntime = join(target, "Contents/Resources/NIR-RUNTIME.json");
    writeFileSync(oldRuntime, `${JSON.stringify({ nodeExecutable: process.execPath })}\n`);
    writeFileSync(join(target, "Contents/Resources/NIR-LOCAL-BUILD.json"),
      '{"format":"nir-local-test-build-v1","distribution":"not-a-public-installer"}\n');
    writeFileSync(join(candidate, "Contents/Resources/NIR-LOCAL-BUILD.json"),
      '{"format":"nir-local-test-build-v2","distribution":"not-a-public-installer","sequence":2}\n');
    for (const app of [target, candidate]) {
      execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app]);
    }
    assert.throws(() => inspectLocalMacWallet(target), /no signed byte pin/);
    const old = inspectLocalMacWallet(target, { allowLegacyRuntime: true });
    const cli = new URL("../blockchain/wallet-macos-local-install.mjs", import.meta.url).pathname;
    const legacyInspection = JSON.parse(execFileSync(process.execPath,
      [cli, "inspect-legacy", target], { encoding: "utf8" }));
    assert.equal(legacyInspection.hash, old.hash);
    assert.equal(legacyInspection.runtimeBound, false);
    const next = inspectLocalMacWallet(candidate);
    assert.equal(old.runtimeBound, false);
    assert.equal(next.runtimeBound, true);
    const helper = join(root, "wallet-app-exchange");
    execFileSync("/usr/bin/clang", ["-Wall", "-Wextra", "-Werror",
      new URL("../macos/wallet-app-exchange.c", import.meta.url).pathname,
      "-o", helper]);
    const update = { target, candidate, expectedOldHash: old.hash,
      expectedNewHash: next.hash, exchangeExecutable: helper };
    assert.throws(() => installLocalMacWallet(update), /no signed byte pin/);
    const result = JSON.parse(execFileSync(process.execPath,
      [cli, "install-legacy", target, candidate, old.hash, next.hash], { encoding: "utf8" }));
    assert.equal(result.hash, next.hash);
    assert.equal(inspectLocalMacWallet(target).hash, next.hash);
    assert.equal(inspectLocalMacWallet(candidate, { allowLegacyRuntime: true }).hash, old.hash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native runner rejects a changed external executable before launching it", {
  skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync("/private/tmp/nir-wallet-runner-pin-");
  try {
    const app = join(root, "NIR Wallet.app");
    const runtime = join(root, "runtime");
    buildMacWallet(app);
    const source = join(root, "runtime.c");
    writeFileSync(source, '#include <stdio.h>\nint main(int argc, char **argv) { puts(argc > 1 ? argv[1] : ""); return 0; }\n');
    execFileSync("/usr/bin/clang", [source, "-o", runtime]);
    const pin = createHash("sha256").update(readFileSync(runtime)).digest("hex");
    const runner = join(app, "Contents/MacOS/wallet-runner");
    assert.equal(execFileSync(runner, [runtime, "probe", pin], { encoding: "utf8" }).trim(),
      "probe");
    const replacement = join(root, "replacement");
    writeFileSync(source, "int main(void) { return 0; }\n");
    execFileSync("/usr/bin/clang", [source, "-o", replacement]);
    renameSync(replacement, runtime);
    assert.throws(() => execFileSync(runner, [runtime, "probe", pin],
      { encoding: "utf8" }), /initialization failed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
