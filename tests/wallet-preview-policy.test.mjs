import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("wallet preview command is explicitly bound to IPv4 loopback", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["wallet:preview"],
    "python3 -m http.server 8765 --bind 127.0.0.1 --directory wallet-ui");
  assert.doesNotMatch(packageJson.scripts["wallet:preview"], /(?:0\.0\.0\.0|--bind\s+::)(?:\s|$)/u);
});
