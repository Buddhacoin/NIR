import assert from "node:assert/strict";
import {
  lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  createCertificateRecord,
  EMPTY_CERTIFICATE_RECORD_HASH,
} from "../blockchain/certificate-lifecycle.mjs";
import {
  certificateStorePaths,
  installCertificateRecord,
  loadCertificateHistory,
} from "../blockchain/certificate-lifecycle-store.mjs";

test("certificate history survives restart and repairs one torn copy", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-certificate-store-"));
  try {
    const wallets = Array.from({ length: 4 }, generateWallet);
    const context = {
      currentHeight: 1,
      minimumActivationDelay: 2,
      networkId: "nir-certificate-store-test",
      peerRegistryHash: "a".repeat(64),
      topologyHistoryHash: "b".repeat(64),
      validators: wallets.map(publicWallet),
    };
    const record = createCertificateRecord({
      activationHeight: 3,
      certificate: { serial: "c1", sha256: "c".repeat(64) },
      networkId: context.networkId,
      operation: "issue",
      overlapUntilHeight: 3,
      peerRegistryHash: context.peerRegistryHash,
      previousRecordHash: EMPTY_CERTIFICATE_RECORD_HASH,
      sequence: 0,
      topologyHistoryHash: context.topologyHistoryHash,
      validatorAddress: wallets[0].address,
    }, wallets.slice(0, 3));
    assert.equal(installCertificateRecord(directory, record, context).status, "installed");
    assert.equal(loadCertificateHistory(directory, context).history.length, 1);
    const paths = certificateStorePaths(directory);
    writeFileSync(paths.primary, "{torn", { mode: 0o600 });
    const recovered = loadCertificateHistory(directory, context);
    assert.equal(recovered.history.length, 1);
    assert.equal(recovered.recoveredCopies, 1);
    assert.equal(readFileSync(paths.primary, "utf8"), readFileSync(paths.backup, "utf8"));

    rmSync(paths.primary);
    symlinkSync(paths.backup, paths.primary);
    const symlinkRecovered = loadCertificateHistory(directory, context);
    assert.equal(symlinkRecovered.recoveredCopies, 1);
    assert.equal(lstatSync(paths.primary).isSymbolicLink(), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
