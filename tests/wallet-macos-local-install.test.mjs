import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync,
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
