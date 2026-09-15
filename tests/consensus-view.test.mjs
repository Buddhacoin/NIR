import assert from "node:assert/strict";
import test from "node:test";

import { selectHighestCertifiedProposal } from "../blockchain/consensus-view.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function group(round, count, marker) {
  return {
    certified: true,
    count,
    prepareCertificate: [{ validator: marker }],
    proposal: { marker, round },
  };
}

test("one reported prepare certificate is sufficient regardless of round", () => {
  assert.equal(selectHighestCertifiedProposal(new Map([
    [HASH_A, group(0, 1, "prepare-qc")],
  ]), 4).proposal.marker, "prepare-qc");
  assert.throws(() => selectHighestCertifiedProposal(new Map([
    [HASH_A, { ...group(0, 1, "unverified"), certified: false }],
  ]), 4), /lock group is invalid/);
});

test("the highest certified round wins over more reports from an older round", () => {
  const selected = selectHighestCertifiedProposal(new Map([
    [HASH_A, group(0, 3, "old")],
    [HASH_B, group(2, 1, "highest-certificate")],
  ]), 4);
  assert.equal(selected.proposal.marker, "highest-certificate");
  assert.equal(selected.proposal.round, 2);
});

test("conflicting values at the same highest certified round fail closed", () => {
  assert.throws(() => selectHighestCertifiedProposal(new Map([
    [HASH_A, group(2, 1, "first")],
    [HASH_B, group(2, 1, "second")],
  ]), 4), /conflicting values carry the same highest view certificate/);
});
