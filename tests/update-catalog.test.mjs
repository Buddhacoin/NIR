import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { generateWallet, publicWallet, signObject } from "../blockchain/crypto.mjs";
import { selectVerifiedUpdate, verifyDownloadedUpdateBytes, verifyGithubUpdateRelease,
  verifySignedUpdateCatalog } from "../blockchain/update-catalog.mjs";

const releaseTag = "nir-v0.2.1";
const artifact = (target, filename) => ({
  bytes: 1024,
  filename,
  product: "wallet",
  sequence: 3,
  sha256: "a".repeat(64),
  target,
  version: "0.2.1",
});

function fixture() {
  const signer = generateWallet();
  const catalog = {
    artifacts: [
      artifact("linux-x64", "nir-wallet-linux-x64.zip"),
      artifact("macos-arm64", "nir-wallet-macos-arm64.zip"),
      artifact("windows-x64", "nir-wallet-windows-x64.zip"),
    ],
    format: "nir-update-catalog-v1",
    releaseTag,
    sourceRevision: "b".repeat(40),
  };
  return { catalog, envelope: { catalog, signature: signObject(catalog, signer, "NIR_UPDATE_CATALOG"),
    signer: publicWallet(signer) }, signer };
}

test("a signed catalog selects only the exact platform and a newer build", () => {
  const { envelope, signer } = fixture();
  const verified = verifySignedUpdateCatalog(envelope, { trustedAddress: signer.address,
    releaseTag });
  assert.equal(selectVerifiedUpdate(verified, { product: "wallet", target: "linux-x64",
    installedSequence: 2, installedVersion: "0.2.0" }).filename, "nir-wallet-linux-x64.zip");
  assert.equal(selectVerifiedUpdate(verified, { product: "wallet", target: "linux-arm64",
    installedSequence: 2, installedVersion: "0.2.0" }), null);
  assert.equal(selectVerifiedUpdate(verified, { product: "wallet", target: "linux-x64",
    installedSequence: 3, installedVersion: "0.2.0" }), null);
  assert.equal(selectVerifiedUpdate(verified, { product: "wallet", target: "linux-x64",
    installedSequence: 2, installedVersion: "0.2.2" }), null);
});

test("a changed package digest, signer or release tag is rejected", () => {
  const { envelope, signer } = fixture();
  const changed = structuredClone(envelope);
  changed.catalog.artifacts[0].sha256 = "c".repeat(64);
  assert.throws(() => verifySignedUpdateCatalog(changed, { trustedAddress: signer.address,
    releaseTag }), /signature/i);
  assert.throws(() => verifySignedUpdateCatalog(envelope, {
    trustedAddress: generateWallet().address, releaseTag,
  }), /trusted/i);
  assert.throws(() => verifySignedUpdateCatalog(envelope, {
    trustedAddress: signer.address, releaseTag: "other-tag",
  }), /release tag/i);
});

test("duplicate targets and unsafe filenames are rejected even when signed", () => {
  const { catalog, signer } = fixture();
  catalog.artifacts.push({ ...catalog.artifacts[0] });
  let envelope = { catalog, signature: signObject(catalog, signer, "NIR_UPDATE_CATALOG"),
    signer: publicWallet(signer) };
  assert.throws(() => verifySignedUpdateCatalog(envelope, { trustedAddress: signer.address,
    releaseTag }), /duplicate/i);
  catalog.artifacts.pop();
  catalog.artifacts[0].filename = "../wallet.zip";
  envelope = { catalog, signature: signObject(catalog, signer, "NIR_UPDATE_CATALOG"),
    signer: publicWallet(signer) };
  assert.throws(() => verifySignedUpdateCatalog(envelope, { trustedAddress: signer.address,
    releaseTag }), /filename/i);
});

test("GitHub release assets must match every signed package byte pin", () => {
  const { envelope, signer } = fixture();
  const release = {
    draft: false,
    prerelease: false,
    tag_name: releaseTag,
    html_url: `https://github.com/Buddhacoin/NIR/releases/tag/${releaseTag}`,
    assets: envelope.catalog.artifacts.map((entry) => ({
      browser_download_url: `https://github.com/Buddhacoin/NIR/releases/download/${releaseTag}/${entry.filename}`,
      digest: `sha256:${entry.sha256}`,
      name: entry.filename,
      size: entry.bytes,
      state: "uploaded",
    })),
  };
  const verified = verifyGithubUpdateRelease(release, envelope, {
    trustedAddress: signer.address,
  });
  assert.equal(verified.artifacts.length, 3);
  assert.throws(() => selectVerifiedUpdate(envelope.catalog, { product: "wallet",
    target: "linux-x64", installedSequence: 2, installedVersion: "0.2.0" }), /not verified/i);
  for (const change of [
    (copy) => { copy.assets[0].digest = `sha256:${"f".repeat(64)}`; },
    (copy) => { copy.assets[0].browser_download_url = "https://example.org/fake.zip"; },
    (copy) => { copy.assets.pop(); },
    (copy) => { copy.prerelease = true; },
  ]) {
    const copy = structuredClone(release);
    change(copy);
    assert.throws(() => verifyGithubUpdateRelease(copy, envelope, {
      trustedAddress: signer.address,
    }), /release|asset/i);
  }
});

test("download acceptance hashes actual bytes after GitHub and signer checks", () => {
  const { catalog, signer } = fixture();
  const bytes = Buffer.alloc(1024, 7);
  catalog.artifacts[0].sha256 = createHash("sha256").update(bytes).digest("hex");
  const envelope = { catalog, signer: publicWallet(signer),
    signature: signObject(catalog, signer, "NIR_UPDATE_CATALOG") };
  const release = {
    draft: false, prerelease: false, tag_name: releaseTag,
    html_url: `https://github.com/Buddhacoin/NIR/releases/tag/${releaseTag}`,
    assets: catalog.artifacts.map((entry) => ({
      browser_download_url: `https://github.com/Buddhacoin/NIR/releases/download/${releaseTag}/${entry.filename}`,
      digest: `sha256:${entry.sha256}`, name: entry.filename, size: entry.bytes, state: "uploaded",
    })),
  };
  const signedOnly = verifySignedUpdateCatalog(envelope, { trustedAddress: signer.address,
    releaseTag });
  const installed = { product: "wallet", target: "linux-x64", installedSequence: 2,
    installedVersion: "0.2.0" };
  assert.throws(() => verifyDownloadedUpdateBytes(signedOnly, installed, bytes),
    /GitHub release/i);
  const verified = verifyGithubUpdateRelease(release, envelope, { trustedAddress: signer.address });
  assert.equal(verifyDownloadedUpdateBytes(verified, installed, bytes).sha256,
    catalog.artifacts[0].sha256);
  assert.throws(() => verifyDownloadedUpdateBytes(verified, installed,
    Buffer.alloc(1024, 8)), /bytes differ/i);
  assert.throws(() => verifyDownloadedUpdateBytes(verified, installed,
    Buffer.alloc(1023, 7)), /bytes differ/i);
  assert.throws(() => verifyDownloadedUpdateBytes(verified, { ...installed,
    installedSequence: 3 }, bytes), /not selected/i);
  assert.throws(() => verifyDownloadedUpdateBytes(verified, { ...installed,
    target: "linux-arm64" }, bytes), /not selected/i);
  assert.throws(() => verifyDownloadedUpdateBytes(verified, { ...installed,
    target: "windows-x64" }, bytes), /bytes differ/i);
});
