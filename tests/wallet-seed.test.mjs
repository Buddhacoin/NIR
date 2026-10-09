import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { signObject, verifyObject } from "../blockchain/crypto.mjs";
import { entropyFromMnemonic, mnemonicFromEntropy, walletFromMnemonic } from
  "../blockchain/wallet-seed.mjs";

const ZERO_PHRASE = `${"abandon ".repeat(23)}art`;

test("24-word phrase follows the BIP-39 checksum vector", () => {
  const entropy = Buffer.alloc(32);
  assert.equal(mnemonicFromEntropy(entropy), ZERO_PHRASE);
  assert.deepEqual(entropyFromMnemonic(`  ${ZERO_PHRASE.toUpperCase()}  `), entropy);
  assert.throws(() => entropyFromMnemonic(ZERO_PHRASE.replace(/art$/, "zoo")), /checksum/);
  assert.throws(() => entropyFromMnemonic("abandon ".repeat(23)), /24 valid/);
  assert.throws(() => mnemonicFromEntropy(Buffer.alloc(16)), /32 bytes/);
  assert.throws(() => entropyFromMnemonic("x".repeat(513)), /bounded/);
});

test("phrase alone reproduces the same ML-DSA key and every indexed address", () => {
  assert.equal(walletFromMnemonic(ZERO_PHRASE, 0).address,
    "nir1d074c43687c8d3534a915efcf8dd05c39fa076d1d8fb8c9062de8681e3f4fce7");
  assert.equal(walletFromMnemonic(ZERO_PHRASE, 1).address,
    "nir1ff48e4ff5d5c57afe8eac1eb2bea54265751c68bf756bc6ffb36ece0320b665a");
  assert.equal(walletFromMnemonic(ZERO_PHRASE, 2).address,
    "nir1b47c1f33c57c52eb1614ad49be2f0674e84d0b5c94b7cc10050fb219d2cc41f6");
  const fresh = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { walletFromMnemonic } from ${JSON.stringify(new URL("../blockchain/wallet-seed.mjs", import.meta.url).href)};
     let phrase = ""; for await (const chunk of process.stdin) phrase += chunk;
     process.stdout.write(walletFromMnemonic(phrase, 2).address);`],
  { input: ZERO_PHRASE, encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(fresh.stdout,
    "nir1b47c1f33c57c52eb1614ad49be2f0674e84d0b5c94b7cc10050fb219d2cc41f6");
  const phrase = mnemonicFromEntropy(Buffer.alloc(32, 7));
  const first = walletFromMnemonic(phrase, 0);
  const recovered = walletFromMnemonic(`\n${phrase}\n`, 0);
  const second = walletFromMnemonic(phrase, 1);
  assert.deepEqual(first, recovered);
  assert.notEqual(first.address, second.address);
  assert.notEqual(first.privateKey, second.privateKey);
  const message = { networkId: "nir-local-rehearsal", amount: "1" };
  assert.equal(verifyObject(message, signObject(message, recovered, "TEST"),
    first.publicKey, "TEST"), true);
  assert.throws(() => walletFromMnemonic(phrase, -1), /index/);
  assert.throws(() => walletFromMnemonic(phrase, 2 ** 31), /index/);
});
