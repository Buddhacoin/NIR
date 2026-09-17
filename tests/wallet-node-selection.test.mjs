import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeNodePolicy,
  selectNodeHealth,
} from "../wallet-ui/node-selection.js";

const tip = (character) => character.repeat(64);
const health = (height, hash = tip("a")) => ({
  height, networkId: "nir-node-selection-test", status: "ready", tipHash: hash,
});

test("wallet selects the highest view confirmed by the required node count", () => {
  const selected = selectNodeHealth([
    { url: "https://node-a.example", health: health(12) },
    { url: "https://node-b.example", health: health(12) },
    { url: "https://node-c.example", health: health(13, tip("b")) },
  ], {
    expectedNetworkId: "nir-node-selection-test",
    minimumAgreement: 2,
    minimumHeight: 10,
  });
  assert.equal(selected.health.height, 12);
  assert.equal(selected.agreeingNodes, 2);
  assert.equal(selected.availableNodes, 3);
});

test("wallet fails closed on same-height conflicts and insufficient agreement", () => {
  assert.throws(() => selectNodeHealth([
    { url: "https://node-a.example", health: health(12, tip("a")) },
    { url: "https://node-b.example", health: health(12, tip("b")) },
  ], {
    expectedNetworkId: "nir-node-selection-test", minimumAgreement: 1,
  }), /conflicting finalized hashes/);
  assert.throws(() => selectNodeHealth([
    { url: "https://node-a.example", health: health(12) },
    { url: "https://node-b.example", health: health(11, tip("b")) },
  ], {
    expectedNetworkId: "nir-node-selection-test", minimumAgreement: 2,
  }), /agreement is insufficient/);
  assert.throws(() => selectNodeHealth([
    { url: "https://node-a.example", health: health(12, tip("b")) },
  ], {
    expectedNetworkId: "nir-node-selection-test",
    minimumAgreement: 1,
    minimumHeight: 12,
    trustedTipHash: tip("a"),
  }), /agreement is insufficient/);
});

test("wallet node policy rejects duplicate and non-origin URLs", () => {
  assert.deepEqual(normalizeNodePolicy({
    minimumAgreement: 2,
    nodes: ["https://node-a.example", "https://node-b.example"],
  }), {
    minimumAgreement: 2,
    nodes: ["https://node-a.example", "https://node-b.example"],
  });
  assert.throws(() => normalizeNodePolicy({
    minimumAgreement: 1,
    nodes: ["https://node-a.example", "https://node-a.example"],
  }), /unique/);
  assert.throws(() => normalizeNodePolicy({
    minimumAgreement: 1, nodes: ["https://node-a.example/path"],
  }), /exact HTTP origin/);
  assert.throws(() => normalizeNodePolicy({
    minimumAgreement: 1, nodes: ["http://node-a.example"],
  }), /exact HTTP origin/);
});
