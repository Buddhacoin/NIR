import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { checksumAddress, parseAddress } from "../wallet-ui/address-checksum.js";

const lower = (seed) => `nir1${createHash("sha3-256").update(seed).digest("hex")}`;

test("checksummed addresses keep the chain address and follow the published rule", () => {
  for (let i = 0; i < 200; i++) {
    const address = lower(`account ${i}`);
    const checked = checksumAddress(address);
    assert.equal(checked.toLowerCase(), address);
    assert.ok(checked.startsWith("nir1"));
    // The rule, computed independently with Node's SHA-256.
    const hash = createHash("sha256").update(`NIR/ADDRESS-CASE/v1\0${address}`).digest();
    const expected = "nir1" + [...address.slice(4)].map((c, j) =>
      ((hash[j >> 3] >> (7 - (j & 7))) & 1) && c >= "a" ? c.toUpperCase() : c).join("");
    assert.equal(checked, expected);
    assert.deepEqual(parseAddress(checked), { address, checked: true });
    assert.deepEqual(parseAddress(`  ${address} `), { address, checked: false });
  }
});

test("a mistyped character in a checksummed address is caught", () => {
  let caught = 0;
  let tries = 0;
  for (let i = 0; i < 100; i++) {
    const checked = checksumAddress(lower(`typo ${i}`));
    const position = 4 + (i * 7) % 64;
    const original = checked[position];
    const replacement = original.toLowerCase() === "7" ? "8" : "7";
    const typo = checked.slice(0, position) + replacement + checked.slice(position + 1);
    // Typing all lower or all upper case carries no checksum to check.
    const hex = typo.slice(4);
    if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) continue;
    tries++;
    try { parseAddress(typo); } catch (error) { caught++; assert.match(error.message, /опечатка/); }
  }
  assert.ok(caught / tries > 0.9, `${caught}/${tries}`);
  for (const bad of ["", "nir1", "NIR1" + "a".repeat(64), `nir1${"g".repeat(64)}`, `nir1${"a".repeat(63)}`, 42]) {
    assert.throws(() => parseAddress(bad), /неверен/);
  }
});
