import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findOldCopies, trashOldCopies } from "../blockchain/old-app-copies.mjs";

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
    assert.deepEqual(trashOldCopies(miner, { home, search }).sort(), [oldLab, oldWallet].sort());
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
    const moved = trashOldCopies(installed, { home, search: () => [installed, stuck, gone],
      moveToTrash: (path) => { seen.push(path); if (path === stuck) throw new Error("not moved"); rmSync(path, { recursive: true }); } });
    assert.deepEqual(seen.sort(), [gone, stuck].sort());
    assert.deepEqual(moved, [gone]);
    assert.ok(existsSync(stuck));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
