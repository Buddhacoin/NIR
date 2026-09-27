import assert from "node:assert/strict";
import test from "node:test";

import {
  createCanonicalIpcFrameDecoder,
  encodeCanonicalIpcFrame,
} from "../blockchain/canonical-ipc-framing.mjs";

const OPTIONS = { label: "test frame", maximumBytes: 256 };

test("canonical IPC framing survives every split and coalesced frames", () => {
  const first = encodeCanonicalIpcFrame({ a: 1, z: "hello" }, OPTIONS);
  const second = encodeCanonicalIpcFrame([true, null, "two"], OPTIONS);
  for (let split = 0; split <= first.length; split += 1) {
    const decoder = createCanonicalIpcFrameDecoder(OPTIONS);
    assert.deepEqual(decoder.push(first.subarray(0, split)),
      split === first.length ? [{ a: 1, z: "hello" }] : []);
    assert.deepEqual(decoder.push(first.subarray(split)),
      split === first.length ? [] : [{ a: 1, z: "hello" }]);
    decoder.finish();
  }
  const decoder = createCanonicalIpcFrameDecoder(OPTIONS);
  assert.deepEqual(decoder.push(Buffer.concat([first, second])), [
    { a: 1, z: "hello" }, [true, null, "two"],
  ]);
  decoder.finish();
});

test("canonical IPC framing rejects hostile lengths, bytes, and incomplete frames", () => {
  assert.throws(() => encodeCanonicalIpcFrame("x".repeat(257), OPTIONS), /bounded limit/);
  for (const bytes of [
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([0, 0, 1, 1]),
    Buffer.concat([Buffer.from([0, 0, 0, 13]), Buffer.from('{"z":1,"a":2}')]),
    Buffer.concat([Buffer.from([0, 0, 0, 2]), Buffer.from([0xc3, 0x28])]),
  ]) {
    const decoder = createCanonicalIpcFrameDecoder(OPTIONS);
    assert.throws(() => decoder.push(bytes));
    assert.throws(() => decoder.push(Buffer.alloc(0)), /poisoned/);
  }
  const decoder = createCanonicalIpcFrameDecoder(OPTIONS);
  decoder.push(Buffer.from([0, 0, 0]));
  assert.throws(() => decoder.finish(), /before completion/);
});
