import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const contributing = read("CONTRIBUTING.md");
const contributingText = contributing.replace(/\s+/gu, " ");
const readme = read("README.md");
const security = read("SECURITY.md");

test("public contribution policy is discoverable and names the canonical checks", () => {
  assert.match(readme, /\[`CONTRIBUTING\.md`\]\(CONTRIBUTING\.md\)/u);
  assert.match(contributing, /npm run verify/u);
  assert.match(contributing, /npm run protocol:manifest-generate/u);
  assert.match(contributing, /npm run protocol:manifest-verify/u);
  assert.match(contributing, /docs\/public-testnet-gates\.md/u);
  assert.match(contributing, /SECURITY\.md/u);
});

test("public contribution policy requires protocol and secret-safety evidence", () => {
  for (const required of [
    "failure model",
    "migration",
    "rollback",
    "recovery",
    "private keys",
    "access tokens",
    "rotate or revoke",
    "private repository security advisory",
    "no monetary value"
  ]) {
    assert.ok(contributingText.includes(required), `missing public policy: ${required}`);
  }

  assert.match(contributing, /must not silently change canonical encoding/u);
  assert.match(contributing, /author is not the sole evidence source/u);
  assert.match(security, /private GitHub security advisories/u);
});
