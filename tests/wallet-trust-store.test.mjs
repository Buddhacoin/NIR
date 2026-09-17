import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  enforceWalletTrustCheckpoint,
  loadWalletTrustCheckpoint,
  saveWalletTrustCheckpoint,
} from "../blockchain/wallet-trust-store.mjs";

function statement(height = 12) {
  return {
    height,
    networkId: "nir-wallet-trust-test",
    stateRoot: "a".repeat(64),
    tipHash: "b".repeat(64),
    validatorSetId: "c".repeat(64),
  };
}

test("wallet trust checkpoint persists monotonic finalized state", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-trust-test-"));
  try {
    const path = join(directory, "wallet.trust.json");
    const saved = saveWalletTrustCheckpoint(path, statement());
    const loaded = loadWalletTrustCheckpoint(path, "nir-wallet-trust-test");
    assert.deepEqual(loaded, saved);
    assert.doesNotThrow(() => enforceWalletTrustCheckpoint(loaded, statement()));
    assert.throws(() => enforceWalletTrustCheckpoint(loaded, statement(11)), /roll back/);
    assert.throws(() => enforceWalletTrustCheckpoint(loaded, {
      ...statement(), stateRoot: "d".repeat(64),
    }), /roll back/);
    assert.doesNotThrow(() => enforceWalletTrustCheckpoint(loaded, {
      ...statement(13), stateRoot: "d".repeat(64), tipHash: "e".repeat(64),
    }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet trust checkpoint rejects symbolic links", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-trust-link-test-"));
  try {
    const target = join(directory, "missing.json");
    const link = join(directory, "wallet.trust.json");
    symlinkSync(target, link);
    assert.throws(() => loadWalletTrustCheckpoint(link, "nir-wallet-trust-test"), /unsafe/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
