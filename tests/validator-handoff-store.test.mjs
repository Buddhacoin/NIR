import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createValidatorHandoff } from "../blockchain/validator-handoff.mjs";
import {
  installValidatorHandoff,
  loadValidatorHandoffs,
} from "../blockchain/validator-handoff-store.mjs";

function members(wallets) {
  return wallets.map((wallet) => ({
    ...publicWallet(wallet), operatorId: `validator-${wallet.address.slice(4, 16)}`,
  }));
}

function makeHandoff(previous, next, height) {
  return createValidatorHandoff({
    activationBlockHash: String(height % 10).repeat(64),
    activationHeight: height,
    activationStateRoot: String((height + 1) % 10).repeat(64),
    networkId: "nir-handoff-store-test",
    nextValidators: members(next),
    previousValidators: members(previous),
  }, previous.slice(0, 3), next.slice(0, 3));
}

test("handoff history is redundant, repairable, ordered, and rooted in genesis", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-handoff-store-"));
  const first = Array.from({ length: 4 }, generateWallet);
  const second = [first[0], first[1], ...Array.from({ length: 2 }, generateWallet)];
  const third = [second[0], second[2], ...Array.from({ length: 2 }, generateWallet)];
  const trustAnchor = {
    expectedNetworkId: "nir-handoff-store-test",
    trustedValidators: members(first),
  };
  try {
    installValidatorHandoff(root, makeHandoff(first, second, 10), trustAnchor);
    installValidatorHandoff(root, makeHandoff(second, third, 20), trustAnchor);
    const primary = join(root, "VALIDATOR-HANDOFFS.json");
    const backup = join(root, "VALIDATOR-HANDOFFS.backup.json");
    writeFileSync(primary, "{broken", "utf8");
    const loaded = loadValidatorHandoffs(root, trustAnchor);
    assert.equal(loaded.handoffs.length, 2);
    assert.equal(loaded.recoveredCopies, 1);
    assert.equal(readFileSync(primary, "utf8"), readFileSync(backup, "utf8"));
    assert.deepEqual(loaded.trustedValidators, members(third)
      .sort((left, right) => left.address.localeCompare(right.address)));
    assert.throws(() => installValidatorHandoff(
      root, makeHandoff(first, second, 10), trustAnchor,
    ), /one-third overlap|trust chain|activation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two valid but divergent durable handoff histories fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-handoff-store-conflict-"));
  const first = Array.from({ length: 4 }, generateWallet);
  const left = [first[0], first[1], ...Array.from({ length: 2 }, generateWallet)];
  const right = [first[0], first[2], ...Array.from({ length: 2 }, generateWallet)];
  const rightNext = [right[0], right[1], ...Array.from({ length: 2 }, generateWallet)];
  const trustAnchor = {
    expectedNetworkId: "nir-handoff-store-test",
    trustedValidators: members(first),
  };
  try {
    installValidatorHandoff(root, makeHandoff(first, left, 10), trustAnchor);
    writeFileSync(join(root, "VALIDATOR-HANDOFFS.json"), JSON.stringify([
      makeHandoff(first, right, 11),
      makeHandoff(right, rightNext, 21),
    ]), "utf8");
    assert.throws(() => loadValidatorHandoffs(root, trustAnchor), /copies conflict/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
