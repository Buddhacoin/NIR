import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PROOF_CHECK_PROFILE_V1, checkProofSolution, inspectProofTask, parseKernelExport,
} from "../blockchain/proof-export.mjs";
import { runKernelCheck } from "../blockchain/proof-kernel.mjs";

// Exports produced by Lean 4.35.0 from tests/fixtures/proof-mining/lean via generate.sh.
const fixture = (name) => readFileSync(new URL(`fixtures/proof-mining/${name}.ndjson`, import.meta.url), "utf8");
const task = fixture("task");
const valid = fixture("valid");

// The kernel half needs the pinned nanoda checker binary; CI without it
// still runs every policy test.
const checkerPath = process.env.NIR_PROOF_CHECKER;
const kernel = { skip: checkerPath ? false : "set NIR_PROOF_CHECKER to the pinned nanoda_bin" };

function nextIndex(text, tag) {
  let next = tag === "ie" ? 0 : 1;
  for (const line of text.trimEnd().split("\n").slice(1)) {
    const record = JSON.parse(line);
    if (tag in record) next = record[tag] + 1;
  }
  return next;
}

function append(text, ...records) {
  return `${text.trimEnd()}\n${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

function replaceLine(text, predicate, mutate) {
  const lines = text.trimEnd().split("\n");
  const at = lines.findIndex((line, i) => i > 0 && predicate(JSON.parse(line)));
  assert.notEqual(at, -1);
  lines[at] = JSON.stringify(mutate(JSON.parse(lines[at])));
  return `${lines.join("\n")}\n`;
}

test("a valid proof is accepted by both the policy and the kernel", async (t) => {
  const result = checkProofSolution(task, valid);
  assert.equal(result.taskId, inspectProofTask(task).taskId);
  assert.deepEqual(result.axioms, []);
  assert.match(result.solutionHash, /^[0-9a-f]{64}$/);
  await t.test("kernel", kernel, async () => {
    assert.equal((await runKernelCheck(valid, { checkerPath })).accepted, true);
  });
});

test("the task identity is stable and independent of the solution", () => {
  assert.equal(inspectProofTask(task).taskId, inspectProofTask(task).taskId);
  assert.throws(() => inspectProofTask(valid), /must not contain a solution/);
});

test("sorry, an extra axiom, and native_decide are rejected by declaration", async (t) => {
  for (const [name, axiom] of [
    ["sorry", "sorryAx"],
    ["extraaxiom", "cheat"],
    ["nativedecide", "helper._native.native_decide.ax_1_1"],
  ]) {
    assert.throws(() => checkProofSolution(task, fixture(name)),
      new RegExp(`forbidden axiom ${axiom.replaceAll(".", "\\.")}`));
    await t.test(`kernel also rejects ${name}`, kernel, async () => {
      assert.equal((await runKernelCheck(fixture(name), { checkerPath })).accepted, false);
    });
  }
});

test("kernel-valid proofs of a different statement fail the task binding", async (t) => {
  // Both are correct mathematics, so only the policy half can stop them.
  assert.throws(() => checkProofSolution(task, fixture("otherstatement")),
    /changes the task declaration/);
  assert.throws(() => checkProofSolution(task, fixture("unfoldedtype")),
    /changes the task declaration NIR\.statement/);
  await t.test("kernel accepts them", kernel, async () => {
    assert.equal((await runKernelCheck(fixture("otherstatement"), { checkerPath })).accepted, true);
    assert.equal((await runKernelCheck(fixture("unfoldedtype"), { checkerPath })).accepted, true);
  });
});

test("an allowed axiom name with a different declaration is rejected", async (t) => {
  // `axiom propext : Prop` under the allowed name. A name-based allowlist,
  // like the kernel checker's own, admits it.
  const name = nextIndex(valid, "in");
  const fake = append(valid,
    { in: name, str: { pre: 0, str: "propext" } },
    { axiom: { isUnsafe: false, levelParams: [], name, type: 37 } });
  assert.throws(() => checkProofSolution(task, fake), /forbidden axiom propext/);
  await t.test("kernel admits it by name", kernel, async () => {
    assert.equal((await runKernelCheck(fake, { checkerPath })).accepted, true);
  });
});

test("a single-component name spelled like an allowed axiom is rejected", () => {
  const name = nextIndex(valid, "in");
  const spoof = append(valid,
    { in: name, str: { pre: 0, str: "Quot.sound" } },
    { axiom: { isUnsafe: false, levelParams: [], name, type: 37 } });
  assert.throws(() => checkProofSolution(task, spoof), /forbidden axiom Quot\.sound/);
});

test("an ill-typed proof passes the policy but not the kernel", async (t) => {
  const broken = replaceLine(valid, (r) => r.thm, (r) => ({ thm: { ...r.thm, value: 37 } }));
  assert.deepEqual(checkProofSolution(task, broken).axioms, []);
  await t.test("kernel", kernel, async () => {
    assert.equal((await runKernelCheck(broken, { checkerPath })).accepted, false);
  });
});

test("malformed exports fail closed before reaching the kernel", () => {
  const lines = valid.trimEnd().split("\n");
  const cases = [
    ["forward reference", replaceLine(valid, (r) => r.thm, (r) => ({ thm: { ...r.thm, value: 9_999 } })),
      /undefined expression/],
    ["skipped index", append(valid, { in: nextIndex(valid, "in") + 1, str: { pre: 0, str: "x" } }),
      /not sequential/],
    ["metadata", append(valid, { ie: nextIndex(valid, "ie"), mdata: { expr: 0, data: {} } }),
      /metadata/],
    ["unknown field", replaceLine(valid, (r) => r.thm, (r) => ({ thm: { ...r.thm, extra: 1 } })),
      /unknown or missing fields/],
    ["unsafe definition", replaceLine(valid, (r) => r.def, (r) => ({ def: { ...r.def, safety: "unsafe" } })),
      /only safe definitions/],
    ["partial definition", replaceLine(valid, (r) => r.def, (r) => ({ def: { ...r.def, safety: "partial" } })),
      /only safe definitions/],
    ["duplicate declaration", `${valid.trimEnd()}\n${lines.at(-1)}\n`, /declares a constant twice/],
    ["bad nat literal", append(valid, { ie: nextIndex(valid, "ie"), natVal: "007" }), /nat literal/],
    ["not JSON", `${valid.trimEnd()}\n{\n`, /is not JSON/],
  ];
  for (const [label, text, error] of cases) {
    assert.throws(() => checkProofSolution(task, text), error, label);
  }
  const foreign = valid.replace('"format":{"version":"3.1.0"}', '"format":{"version":"3.2.0"}');
  assert.throws(() => parseKernelExport(foreign), /format version/);
  const otherLean = valid.replace('"version":"4.35.0"', '"version":"4.36.0"');
  assert.throws(() => parseKernelExport(otherLean), /Lean version/);
  assert.throws(() => parseKernelExport(valid, { ...PROOF_CHECK_PROFILE_V1, maxExportBytes: 1_000 }),
    /too large/);
});
