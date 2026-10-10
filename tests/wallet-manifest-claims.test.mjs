import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

for (const name of ["manifest.json", "manifest.webmanifest"]) {
  test(`${name} describes the wallet as a local preview, not an audited network wallet`, () => {
    const manifest = JSON.parse(readFileSync(new URL(`../wallet-ui/${name}`, import.meta.url)));
    assert.match(manifest.description, /wallet preview/i);
    assert.match(manifest.description, /no public network/i);
    assert.match(manifest.description, /no real funds/i);
    assert.match(manifest.description, /not independently audited/i);
    assert.doesNotMatch(manifest.description, /verified|native wallet/i);
  });
}
