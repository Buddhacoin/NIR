import assert from "node:assert/strict";
import test from "node:test";
import { createLocaleWriteQueue } from "../src/locale-write-queue.js";

test("rapid locale changes persist in click order despite delayed storage writes", async () => {
  const calls = [];
  let stored = "ru";
  const write = createLocaleWriteQueue((value) => new Promise((resolve) => {
    calls.push({ value, finish: () => { stored = value; resolve(); } });
  }));
  const english = write("en");
  const russian = write("ru");
  await new Promise(setImmediate);
  assert.deepEqual(calls.map((call) => call.value), ["en"]);
  calls[0].finish();
  await english;
  await new Promise(setImmediate);
  assert.deepEqual(calls.map((call) => call.value), ["en", "ru"]);
  calls[1].finish();
  await russian;
  assert.equal(stored, "ru");
});

test("a failed earlier locale write cannot block a later choice", async () => {
  const values = [];
  const write = createLocaleWriteQueue(async (value) => {
    values.push(value);
    if (value === "en") throw new Error("storage unavailable");
  });
  const first = write("en");
  const second = write("ru");
  await assert.rejects(first, /storage unavailable/);
  await second;
  assert.deepEqual(values, ["en", "ru"]);
});
