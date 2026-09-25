import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  consensusEncodingVersionForProtocol,
  consensusEnvelopeBytes,
  consensusValueBytes,
} from "../blockchain/consensus-codec.mjs";
import { parseConsensusJson } from "../blockchain/consensus-json.mjs";
import { hashObject } from "../blockchain/crypto.mjs";

const vectors = JSON.parse(readFileSync(
  new URL("./vectors/consensus-codec-v1.json", import.meta.url), "utf8",
));

test("normative consensus vectors have stable bytes and hashes", () => {
  assert.equal(vectors.format, "nir-consensus-codec-vectors-v1");
  for (const vector of vectors.vectors) {
    assert.equal(consensusValueBytes(vector.value).toString("hex"), vector.valueHex,
      `${vector.name} value bytes`);
    assert.equal(consensusEnvelopeBytes(vector.domain, vector.value).toString("hex"),
      vector.envelopeHex, `${vector.name} envelope bytes`);
    assert.equal(hashObject(vector.value, vector.domain), vector.hash, `${vector.name} hash`);
  }
});

test("map order cannot change encoded bytes", () => {
  const entries = [
    ["height", 19], ["network", "nir-test"], ["ready", true],
    ["nested", { z: null, a: [1, 2, 3] }],
  ];
  const expected = consensusValueBytes(Object.fromEntries(entries));
  let state = 0x6d2b79f5;
  for (let attempt = 0; attempt < 512; attempt += 1) {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    const shuffled = [...entries];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
      const target = (state >>> 0) % (index + 1);
      [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
    }
    assert.deepEqual(consensusValueBytes(Object.fromEntries(shuffled)), expected);
  }
});

test("types, domains, and structure are unambiguously separated", () => {
  const encodings = [null, false, true, 0, "0", [], {}, [0], { 0: 0 }]
    .map((value) => consensusValueBytes(value).toString("hex"));
  assert.equal(new Set(encodings).size, encodings.length);
  assert.notEqual(hashObject({ value: 1 }, "BLOCK"), hashObject({ value: 1 }, "TRANSFER"));
  assert.throws(() => consensusEnvelopeBytes("block", {}), /domain/);
  assert.throws(() => consensusEnvelopeBytes("BLOCK", {}, { encodingVersion: 2 }),
    /unsupported consensus encoding version/);
  assert.equal(consensusEncodingVersionForProtocol(24), 1);
  assert.equal(consensusEncodingVersionForProtocol(25), 1);
  assert.equal(consensusEncodingVersionForProtocol(26), 1);
  assert.equal(consensusEncodingVersionForProtocol(27), 1);
  assert.equal(consensusEncodingVersionForProtocol(28), 1);
  assert.equal(consensusEncodingVersionForProtocol(29), 1);
  assert.equal(consensusEncodingVersionForProtocol(30), 1);
  assert.throws(() => consensusEncodingVersionForProtocol(32), /no consensus encoding/);
});

test("ambiguous JavaScript values fail closed", () => {
  const sparse = [];
  sparse.length = 1;
  const accessor = {};
  Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
  const hidden = { visible: 1 };
  Object.defineProperty(hidden, "hidden", { enumerable: false, value: 2 });
  const extraArray = [1];
  extraArray.extra = 2;
  const cyclic = {};
  cyclic.self = cyclic;
  const symbolKey = { value: 1 };
  symbolKey[Symbol("hidden")] = 2;
  const nonNfcKey = { ["e\u0301"]: 1 };
  const exotic = Object.create(null);
  exotic.value = 1;

  for (const value of [
    undefined, NaN, Infinity, -Infinity, -0, 1.5, Number.MAX_SAFE_INTEGER + 1,
    1n, Symbol("value"), () => 1, new Date(0), sparse, accessor, hidden,
    extraArray, cyclic, symbolKey, nonNfcKey, exotic, new Proxy({ value: 1 }, {}),
    "\ud800",
  ]) {
    assert.throws(() => consensusValueBytes(value));
  }
  assert.doesNotThrow(() => consensusValueBytes(Object.freeze({ value: 1 })));
  assert.notDeepEqual(consensusValueBytes("é"), consensusValueBytes("e\u0301"));
});

test("strict consensus JSON rejects duplicate keys and numeric ambiguity", () => {
  assert.deepEqual(parseConsensusJson('{"b":[true,null],"a":1}'), {
    b: [true, null], a: 1,
  });
  for (const source of [
    '{"a":1,"a":2}', '{"e\\u0301":1}', '{"a":1.0}', '{"a":1e0}',
    '{"a":-0}', '{"a":9007199254740992}', '{"a":"\\ud800"}',
    '{"a":1,}', '[1,]', 'undefined',
  ]) assert.throws(() => parseConsensusJson(source), /canonical data/);
  assert.throws(() => consensusValueBytes(Array(100_001).fill(null)), /too large/);
  assert.throws(() => parseConsensusJson(`[${"0,".repeat(100_000)}0]`),
    /canonical data/);
});
