import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findOldCopies, revealOldCopies, trashOldCopies } from "../blockchain/old-app-copies.mjs";

function app(path, bundleId) {
  mkdirSync(join(path, "Contents"), { recursive: true });
  writeFileSync(join(path, "Contents", "Info.plist"),
    `<plist><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`);
  return path;
}

test("old NIR copies go to the Trash; installed apps and other apps stay", () => {
  const home = mkdtempSync(join(tmpdir(), "nir-old-copies-"));
  try {
    const installed = join(home, "Applications", "NIR");
    const wallet = app(join(installed, "NIR Wallet.app"), "org.nir.wallet-setup-test");
    const miner = app(join(installed, "NIR Miner.app"), "org.nir.model-lab-local-test");
    const oldWallet = app(join(home, "Desktop", "NIR Wallet-2026-10-01.app"), "org.nir.wallet-setup-test");
    const oldLab = app(join(home, "NIR Model Lab-before.app"), "org.nir.model-lab-local-test");
    const stranger = app(join(home, "NIR Notes.app"), "com.example.notes");
    const search = () => [wallet, miner, oldWallet, oldLab, stranger, "", "relative.app"];
    assert.deepEqual(findOldCopies(wallet, { home, search }), [oldLab, oldWallet].sort());
    const result = trashOldCopies(miner, { home, search });
    assert.deepEqual(result.moved.sort(), [oldLab, oldWallet].sort());
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.deleted, []);
    for (const kept of [wallet, miner, stranger]) assert.ok(existsSync(kept), kept);
    assert.equal(existsSync(oldWallet), false);
    assert.deepEqual(readdirSync(join(home, ".Trash")).sort(), ["NIR Model Lab-before.app", "NIR Wallet-2026-10-01.app"]);
    // Copies already in the Trash are not found again.
    assert.deepEqual(findOldCopies(wallet, { home, search: () => readdirSync(join(home, ".Trash"))
      .map((name) => join(home, ".Trash", name)) }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a copy counts as moved only once it has left its folder", () => {
  const home = mkdtempSync(join(tmpdir(), "nir-old-copies-system-"));
  try {
    const installed = app(join(home, "Applications", "NIR", "NIR Wallet.app"), "org.nir.wallet-setup-test");
    const stuck = app(join(home, "Desktop", "NIR Wallet old.app"), "org.nir.wallet-setup-test");
    const gone = app(join(home, "Desktop", "NIR Miner old.app"), "org.nir.model-lab-local-test");
    const seen = [];
    const search = () => [installed, stuck, gone];
    const result = trashOldCopies(installed, { home, search,
      moveToTrash: (path) => { seen.push(path); if (path === stuck) throw new Error("not moved"); rmSync(path, { recursive: true }); },
      remove: () => { throw new Error("not removed"); } });
    assert.deepEqual(seen.sort(), [gone, stuck].sort());
    assert.deepEqual(result, { moved: [gone], deleted: [], failed: [{ path: stuck, reason: "not removed" }] });
    assert.ok(existsSync(stuck));
    // What stayed can be shown in Finder to drag to the Trash by hand.
    const opened = [];
    assert.deepEqual(revealOldCopies(installed, { home, search: () => [installed, stuck], open: (path) => opened.push(path) }), [stuck]);
    assert.deepEqual(opened, [stuck]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a copy the Trash refuses is deleted at once", () => {
  const home = mkdtempSync(join(tmpdir(), "nir-old-copies-delete-"));
  try {
    const installed = app(join(home, "Applications", "NIR", "NIR Wallet.app"), "org.nir.wallet-setup-test");
    const cloudCopy = app(join(home, "Desktop", "NIR Wallet cloud.app"), "org.nir.wallet-setup-test");
    const result = trashOldCopies(installed, { home, search: () => [installed, cloudCopy],
      moveToTrash: () => { throw new Error("not moved"); } });
    assert.deepEqual(result, { moved: [], deleted: [cloudCopy], failed: [] });
    assert.equal(existsSync(cloudCopy), false);
    assert.ok(existsSync(installed));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
