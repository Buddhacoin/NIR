import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ATOMIC_UNITS, MIN_TRANSFER_FEE } from "../blockchain/constants.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import { createNodeHttpServer } from "../blockchain/node-service.mjs";
import { initializeDevnet, PersistentDevNode } from "../blockchain/node-store.mjs";
import { createWalletBridgeServer } from "../blockchain/wallet-bridge.mjs";
import { createWalletFile } from "../blockchain/wallet-files.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

async function jsonRequest(url, { body, headers = {}, method = "GET" } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      origin: "http://127.0.0.1:8765",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  return { response, value };
}

test("wallet flow funds, reviews, signs, submits, and finalizes through real HTTP boundaries", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-wallet-flow-e2e-"));
  const nodeDirectory = join(temporary, "node");
  const vaultPath = join(temporary, "payer.nirvault.json");
  const password = "end-to-end-wallet-password";
  const payer = createWalletFile({ path: vaultPath, password });
  const recipient = generateWallet();
  initializeDevnet(nodeDirectory);
  const node = new PersistentDevNode(nodeDirectory);
  const nodeServer = createNodeHttpServer(node);
  const token = "7".repeat(64);
  let approvals = 0;
  const bridgeServer = createWalletBridgeServer({
    authorize: async () => { approvals += 1; return password; },
    origin: "http://127.0.0.1:8765",
    pairingCode: "24681357",
    sessionToken: token,
    vaultPath,
  });
  try {
    const [nodeUrl, bridgeUrl] = await Promise.all([listen(nodeServer), listen(bridgeServer)]);
    const pairing = await jsonRequest(`${bridgeUrl}/v1/pair`, {
      body: { code: "24681357" }, method: "POST",
    });
    assert.equal(pairing.response.status, 200);
    assert.equal(pairing.value.sessionToken, token);
    const bridgeHeaders = { "x-nir-bridge-token": pairing.value.sessionToken };

    const health = await jsonRequest(`${nodeUrl}/health`);
    assert.equal(health.response.status, 200);
    assert.equal(health.value.valueMode, "valueless-devnet");

    const publicWallet = await jsonRequest(`${bridgeUrl}/v1/wallet`, { headers: bridgeHeaders });
    assert.equal(publicWallet.response.status, 200);
    assert.equal(publicWallet.value.address, payer.address);
    assert.equal(JSON.stringify(publicWallet.value).includes("privateKey"), false);

    const funded = await jsonRequest(`${nodeUrl}/v1/faucet`, {
      body: { amount: (10n * ATOMIC_UNITS).toString(), recipient: payer.address },
      method: "POST",
    });
    assert.equal(funded.response.status, 202);

    const account = await jsonRequest(`${nodeUrl}/v1/accounts/${payer.address}`);
    assert.equal(account.value.atomicBalance, (10n * ATOMIC_UNITS).toString());
    assert.equal(account.value.nextNonce, 0);

    const amount = (2n * ATOMIC_UNITS).toString();
    const quote = await jsonRequest(`${nodeUrl}/v1/fees?amount=${amount}`);
    assert.equal(quote.response.status, 200);
    assert.equal(quote.value.amount, MIN_TRANSFER_FEE.toString());

    const intent = {
      amount,
      fee: quote.value.amount,
      networkId: health.value.networkId,
      nonce: account.value.nextNonce,
      recipient: recipient.address,
      requestId: "8".repeat(64),
    };
    const signed = await jsonRequest(`${bridgeUrl}/v1/sign`, {
      body: intent,
      headers: bridgeHeaders,
      method: "POST",
    });
    assert.equal(signed.response.status, 200);
    assert.equal(approvals, 1);
    assert.equal(signed.value.transaction.sender, payer.address);
    assert.equal(signed.value.transaction.recipient, recipient.address);

    const submitted = await jsonRequest(`${nodeUrl}/v1/transactions`, {
      body: signed.value.transaction,
      method: "POST",
    });
    assert.equal(submitted.response.status, 202);
    assert.equal(typeof submitted.value.transactionId, "string");

    const payerAfter = await jsonRequest(`${nodeUrl}/v1/accounts/${payer.address}`);
    const recipientAfter = await jsonRequest(`${nodeUrl}/v1/accounts/${recipient.address}`);
    assert.equal(payerAfter.value.atomicBalance,
      (8n * ATOMIC_UNITS - MIN_TRANSFER_FEE).toString());
    assert.equal(payerAfter.value.nextNonce, 1);
    assert.equal(recipientAfter.value.atomicBalance, amount);

    const resourceSigned = await jsonRequest(`${bridgeUrl}/v1/sign-resource`, {
      body: {
        amount: (5n * ATOMIC_UNITS).toString(),
        fee: MIN_TRANSFER_FEE.toString(),
        networkId: health.value.networkId,
        nonce: payerAfter.value.nextNonce,
        requestId: "9".repeat(64),
        type: "credit-stake",
      },
      headers: bridgeHeaders,
      method: "POST",
    });
    assert.equal(resourceSigned.response.status, 200);
    assert.equal(approvals, 2);
    const resourceSubmitted = await jsonRequest(`${nodeUrl}/v1/transactions`, {
      body: resourceSigned.value.transaction,
      method: "POST",
    });
    assert.equal(resourceSubmitted.response.status, 202);
    const resourceAccount = await jsonRequest(`${nodeUrl}/v1/accounts/${payer.address}`);
    assert.equal(resourceAccount.value.resources.atomicStake, (5n * ATOMIC_UNITS).toString());
    assert.equal(resourceAccount.value.resources.availableTransferCredits, "0");
    assert.equal(resourceAccount.value.nextNonce, 2);

    const replay = await jsonRequest(`${nodeUrl}/v1/transactions`, {
      body: signed.value.transaction,
      method: "POST",
    });
    assert.equal(replay.response.status, 400);
    assert.match(replay.value.error, /nonce/);
  } finally {
    await Promise.all([close(nodeServer), close(bridgeServer)]);
    rmSync(temporary, { recursive: true, force: true });
  }
});
