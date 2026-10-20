import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CliqueMiningSession } from "../blockchain/clique-mining-session.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";

const until = async (condition, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test("one-button mining pays the linked wallet and sends the miner key's coins there", { timeout: 180_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-mining-session-"));
  const wallet = generateWallet().address;
  let linked = null;
  const session = new CliqueMiningSession({ dataDirectory: temporary, httpPort: null, recipient: () => linked,
    tickMs: 20 });
  try {
    assert.throws(() => session.withdraw(), /no linked wallet/);
    linked = wallet;
    session.start();
    await until(() => session.status().found >= 1, 150_000);
    const status = session.status();
    assert.equal(status.running, true);
    assert.equal(status.wallet.address, wallet);
    assert.ok(status.visited > 0);
    assert.ok(status.events.some((event) => event.kind === "found" && event.k === status.task.k));
    assert.equal(statSync(join(temporary, "miner-key.json")).mode & 0o777, 0o600);
    // Rewards mature after the escrow and go straight to the wallet.
    await until(() => session.status().wallet.balance !== "0.00000000 NIR", 60_000);
    await session.stop();
    assert.equal(session.status().running, false);
    // The miner key only holds faucet coins; everything above the reserve moves.
    const { amount } = session.withdraw();
    assert.ok(BigInt(amount) > 0n);
    assert.throws(() => session.withdraw(), /nothing to send/);
  } finally {
    await session.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});
