import assert from "node:assert/strict";
import test from "node:test";

import { selectHighestCertifiedProposal } from "../blockchain/consensus-view.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function group(round, count, marker) {
  return { count, proposal: { marker, round } };
}

test("round zero lock recovery needs an honest-intersection threshold", () => {
  assert.equal(selectHighestCertifiedProposal(new Map([
    [HASH_A, group(0, 1, "solo")],
  ]), 4), null);
  assert.equal(selectHighestCertifiedProposal(new Map([
    [HASH_A, group(0, 2, "supported")],
  ]), 4).marker, "supported");
});

test("the highest certified round wins over more reports from an older round", () => {
  const selected = selectHighestCertifiedProposal(new Map([
    [HASH_A, group(0, 3, "old")],
    [HASH_B, group(2, 1, "highest-certificate")],
  ]), 4);
  assert.equal(selected.marker, "highest-certificate");
  assert.equal(selected.round, 2);
});

test("conflicting values at the same highest certified round fail closed", () => {
  assert.throws(() => selectHighestCertifiedProposal(new Map([
    [HASH_A, group(2, 1, "first")],
    [HASH_B, group(2, 1, "second")],
  ]), 4), /conflicting values carry the same highest view certificate/);
});
