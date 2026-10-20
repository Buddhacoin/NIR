import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createWalletPreviewServer } from "../blockchain/wallet-preview-cli.mjs";

test("wallet preview command is explicitly bound to IPv4 loopback", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["wallet:preview"],
    "python3 -m http.server 8765 --bind 127.0.0.1 --directory wallet-ui");
  assert.doesNotMatch(packageJson.scripts["wallet:preview"], /(?:0\.0\.0\.0|--bind\s+::)(?:\s|$)/u);
});

test("native local preview serves the pinned language module without a wallet", async () => {
  const server = createWalletPreviewServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/i18n.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/javascript/);
    assert.match(await response.text(), /export function translateWalletText/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
