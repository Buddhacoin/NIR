import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { generateWallet, publicWallet, signObject } from "../blockchain/crypto.mjs";
import { verifyGithubUpdateRelease } from "../blockchain/update-catalog.mjs";
import {
  pinnedUpdateSignerAddress,
  verifyPinnedGithubUpdateRelease,
  selectPinnedUpdate,
  verifyPinnedDownloadedUpdateBytes,
} from "../blockchain/update-trust-anchor.mjs";

// `npm run app-release:key` pins the owner's address once; until then updates
// fail closed.
test("release trust anchor is unset or one pinned address, and fails closed", () => {
  if (pinnedUpdateSignerAddress === null) {
    assert.throws(() => verifyPinnedGithubUpdateRelease({}, {}), /trust anchor is not configured/);
  } else {
    assert.match(pinnedUpdateSignerAddress, /^nir1[0-9a-f]{64}$/);
    assert.throws(() => verifyPinnedGithubUpdateRelease({}, {}), /not trusted/);
  }
  assert.throws(() => selectPinnedUpdate({}, {}), /not verified with the pinned/);
  assert.throws(() => verifyPinnedDownloadedUpdateBytes({}, {}, Buffer.alloc(1)),
    /not verified with the pinned/);
});

test("a caller-chosen release signer cannot smuggle a catalog into pinned update selection", () => {
  const signer = generateWallet(); // Ephemeral test-only key, never a project release key.
  const bytes = Buffer.from("test-only-wallet-package");
  const artifact = { bytes: bytes.length, filename: "nir-wallet-linux-x64.zip",
    product: "wallet", sequence: 3,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    target: "linux-x64", version: "0.2.1" };
  const catalog = { artifacts: [artifact], format: "nir-update-catalog-v1",
    releaseTag: "nir-v0.2.1", sourceRevision: "b".repeat(40) };
  const envelope = { catalog, signature: signObject(catalog, signer, "NIR_UPDATE_CATALOG"),
    signer: publicWallet(signer) };
  const release = { tag_name: catalog.releaseTag, draft: false, prerelease: false,
    html_url: "https://github.com/Buddhacoin/NIR/releases/tag/nir-v0.2.1",
    assets: [{ name: artifact.filename, state: "uploaded", size: artifact.bytes,
      digest: `sha256:${artifact.sha256}`,
      browser_download_url: `https://github.com/Buddhacoin/NIR/releases/download/nir-v0.2.1/${artifact.filename}` }] };
  const identity = { product: "wallet", target: "linux-x64",
    installedSequence: 2, installedVersion: "0.2.0" };
  const callerVerified = verifyGithubUpdateRelease(release, envelope,
    { trustedAddress: signer.address });
  assert.throws(() => selectPinnedUpdate(callerVerified, identity),
    /not verified with the pinned/);
  assert.throws(() => verifyPinnedDownloadedUpdateBytes(callerVerified, identity, bytes),
    /not verified with the pinned/);
  assert.throws(() => verifyPinnedGithubUpdateRelease(release, envelope),
    pinnedUpdateSignerAddress === null ? /trust anchor is not configured/ : /not trusted/);
});
