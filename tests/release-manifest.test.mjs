import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet } from "../blockchain/crypto.mjs";
import {
  createReleaseManifest,
  signReleaseManifest,
  verifyReleaseFiles,
  verifyReleaseManifest,
  verifySignedRelease,
} from "../blockchain/release-manifest.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-release-test-"));
  writeFileSync(join(root, "README.md"), "NIR release\n");
  writeFileSync(join(root, "node.mjs"), "console.log('nir');\n");
  chmodSync(join(root, "node.mjs"), 0o755);
  const paths = ["README.md", "node.mjs"];
  const manifest = createReleaseManifest(root, paths, {
    releaseVersion: "0.2.0",
    sourceRevision: "a".repeat(40),
  });
  return { manifest, paths, root };
}

test("a post-quantum release signature binds revision, file bytes, and executable mode", () => {
  const values = fixture();
  try {
    const wallet = generateWallet();
    const envelope = signReleaseManifest(values.manifest, wallet);
    const verified = verifySignedRelease(envelope, { trustedAddress: wallet.address });
    assert.equal(verified.manifest.manifestHash, values.manifest.manifestHash);
    assert.equal(verifyReleaseFiles(values.root, verified.manifest, values.paths).files.length, 2);
    assert.throws(() => verifySignedRelease(envelope, {
      trustedAddress: generateWallet().address,
    }), /not trusted/);
    writeFileSync(join(values.root, "README.md"), "modified\n");
    assert.throws(() => verifyReleaseFiles(values.root, verified.manifest, values.paths),
      /do not match/);
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});

test("release manifests reject mutation, missing files, extra tracked files, and symlinks", () => {
  const values = fixture();
  try {
    const changed = structuredClone(values.manifest);
    changed.files[0].sha3_256 = "f".repeat(64);
    assert.throws(() => verifyReleaseManifest(changed), /hash is invalid/);
    assert.throws(() => verifyReleaseFiles(values.root, values.manifest, [
      ...values.paths, "extra.mjs",
    ]), /file set/);
    rmSync(join(values.root, "README.md"));
    symlinkSync("node.mjs", join(values.root, "README.md"));
    assert.throws(() => createReleaseManifest(values.root, values.paths, {
      releaseVersion: "0.2.0",
      sourceRevision: "a".repeat(40),
    }), /regular file/);
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});

test("release CLI derives a manifest only from a clean tracked revision", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-release-cli-test-"));
  const output = join(root, "release.json");
  const cli = new URL("../blockchain/release-cli.mjs", import.meta.url).pathname;
  try {
    writeFileSync(join(root, "package.json"), '{"version":"1.2.3"}\n');
    writeFileSync(join(root, "source.mjs"), "export const value = 1;\n");
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "release-test@nir.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "NIR release test"]);
    execFileSync("git", ["-C", root, "add", "package.json", "source.mjs"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
    const created = spawnSync(process.execPath, [cli, "create", root, output], {
      encoding: "utf8",
    });
    assert.equal(created.status, 0, created.stderr);
    const manifest = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(manifest.files.map(({ path }) => path), ["package.json", "source.mjs"]);
    writeFileSync(join(root, "source.mjs"), "export const value = 2;\n");
    const dirty = spawnSync(process.execPath, [cli, "create", root, join(root, "dirty.json")], {
      encoding: "utf8",
    });
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /must be clean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
