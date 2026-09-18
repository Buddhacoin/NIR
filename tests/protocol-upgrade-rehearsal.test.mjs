import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PROTOCOL_VERSION } from "../blockchain/constants.mjs";
import { runProtocolUpgradeRehearsal } from "../blockchain/protocol-upgrade-rehearsal.mjs";

async function available(port) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject); server.listen(port, "127.0.0.1", resolve);
    });
    return true;
  } catch { return false; }
  finally { if (server.listening) await new Promise((resolve) => server.close(resolve)); }
}

async function portRange() {
  for (let base = 20_000; base < 60_000; base += 7) {
    if ((await Promise.all([0, 1, 2, 3].map((offset) => available(base + offset)))).every(Boolean)) return base;
  }
  throw new Error("no four-port range is available for rehearsal");
}

test("multi-process operators rehearse delayed activation and forward-only rollback", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-upgrade-rehearsal-test-"));
  const directory = join(temporary, "drill");
  try {
    const report = await runProtocolUpgradeRehearsal({ directory, firstValidatorPort: await portRange() });
    assert.equal(report.status, "passed");
    assert.equal(report.independentValidatorProcesses, 4);
    assert.equal(report.preActivationCompatible, true);
    assert.equal(report.prematureProposalRejectedBy, 4);
    assert.match(report.prematureProposalHash, /^[0-9a-f]{64}$/);
    assert.equal(report.prematureRejectionReason,
      "block protocol version does not match its activation height");
    assert.match(report.oldBinaryActivationError, /unsupported protocol version/);
    assert.equal(report.restartCatchUp.protocolVersion, PROTOCOL_VERSION + 1);
    assert.equal(report.rollback.downgradeRejected, true);
    assert.equal(report.rollback.historyPrefixPreserved, true);
    assert.equal(report.rollback.mode, "new-quorum-scheduled-forward-upgrade");
    assert.equal(report.rollback.pendingVersion, PROTOCOL_VERSION + 2);
    assert.equal(report.rollback.semanticRollbackExecuted, false);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "rehearsal-report.json"), "utf8")), report);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
