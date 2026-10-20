import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { build } from "esbuild";

import { walletFromMnemonic } from "../../blockchain/wallet-seed.mjs";

const bundled = await build({ entryPoints: [new URL("../src/crypto.js", import.meta.url).pathname],
  bundle: true, write: false, platform: "browser", format: "esm", loader: { ".txt": "text" } });
const source = bundled.outputFiles[0].text;
const browser = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const ZERO_PHRASE = `${"abandon ".repeat(23)}art`;

test("browser phrase and NIR addresses match native wallet derivation", async () => {
  assert.equal(await browser.phraseFromEntropy(new Uint8Array(32)), ZERO_PHRASE);
  for (const index of [0, 1, 2]) {
    const actual = await browser.accountFromPhrase(ZERO_PHRASE, index);
    const native = walletFromMnemonic(ZERO_PHRASE, index);
    assert.equal(actual.address, native.address);
    assert.equal(actual.publicKey, native.publicKey);
  }
  await assert.rejects(browser.normalizePhrase(ZERO_PHRASE.replace(/art$/, "zoo")), /Контрольная/);
});

test("browser profile decrypts only with correct password and unchanged metadata", async () => {
  const password = "correct horse battery staple";
  const encrypted = await browser.encryptPhrase(ZERO_PHRASE, password);
  assert.equal(encrypted.address, walletFromMnemonic(ZERO_PHRASE).address);
  assert.equal(JSON.stringify(encrypted).includes(ZERO_PHRASE), false);
  assert.equal(await browser.decryptPhrase(encrypted, password), ZERO_PHRASE);
  await assert.rejects(browser.decryptPhrase(encrypted, "a different password 123"), /Неверный/);
  await assert.rejects(browser.decryptPhrase({ ...encrypted, address: `nir1${"0".repeat(64)}` }, password), /Неверный/);
  await assert.rejects(browser.encryptPhrase(ZERO_PHRASE, "password"), /минимум 12/);
});
