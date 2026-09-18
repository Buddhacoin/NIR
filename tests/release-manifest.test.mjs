import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet, hashObject } from "../blockchain/crypto.mjs";
import { createDeterministicZip, zipSha3 } from "../blockchain/deterministic-zip.mjs";
import {
  artifactPaths,
  createReleaseArtifact,
  installNodeArtifact,
  installWalletArtifact,
  serializeReleaseArtifact,
  verifyReleaseArtifact,
  verifyNodeInstallation,
  verifyWalletInstallation,
} from "../blockchain/release-artifact.mjs";
import {
  createReleaseManifest,
  signReleaseManifest,
  verifyReleaseFiles,
  verifyReleaseManifest,
  verifySignedRelease,
} from "../blockchain/release-manifest.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-release-test-"));
  mkdirSync(join(root, "blockchain"));
  mkdirSync(join(root, "wallet-ui"));
  writeFileSync(join(root, "README.md"), "NIR release\n");
  writeFileSync(join(root, "node.mjs"), "console.log('nir');\n");
  writeFileSync(join(root, "package.json"), '{"version":"0.2.0"}\n');
  writeFileSync(join(root, "blockchain", "node.mjs"), "export const node = true;\n");
  writeFileSync(join(root, "wallet-ui", "index.html"), "<h1>NIR</h1>\n");
  chmodSync(join(root, "node.mjs"), 0o755);
  const paths = [
    "README.md", "blockchain/node.mjs", "node.mjs", "package.json", "wallet-ui/index.html",
  ];
  const manifest = createReleaseManifest(root, paths, {
    releaseVersion: "0.2.0",
    sourceRevision: "a".repeat(40),
  });
  return { manifest, paths, root };
}

function manualNodePackage(path, contents, wallet) {
  const sourceEntry = {
    executable: false,
    path,
    sha3_256: createHash("sha3-256")
      .update("NIR/RELEASE_FILE/v1\0").update(contents).digest("hex"),
    size: contents.length,
  };
  const manifestPayload = {
    files: [sourceEntry],
    format: "nir-source-release-v1",
    releaseVersion: "0.2.0",
    sourceRevision: "a".repeat(40),
  };
  const manifest = {
    ...manifestPayload,
    manifestHash: hashObject(manifestPayload, "RELEASE_MANIFEST_HASH"),
  };
  const artifactEntry = {
    content: contents.toString("base64"),
    executable: false,
    path,
    sha3_256: createHash("sha3-256")
      .update("NIR/ARTIFACT_FILE/v1\0").update(contents).digest("hex"),
    size: contents.length,
  };
  const artifactPayload = {
    entries: [artifactEntry],
    format: "nir-reproducible-package-v1",
    kind: "node",
    releaseVersion: manifest.releaseVersion,
    sourceManifestHash: manifest.manifestHash,
    sourceRevision: manifest.sourceRevision,
  };
  return {
    artifact: {
      ...artifactPayload,
      artifactHash: hashObject(artifactPayload, "RELEASE_ARTIFACT_HASH"),
    },
    signedRelease: signReleaseManifest(manifest, wallet),
  };
}

test("a post-quantum release signature binds revision, file bytes, and executable mode", () => {
  const values = fixture();
  try {
    const wallet = generateWallet();
    const envelope = signReleaseManifest(values.manifest, wallet);
    const verified = verifySignedRelease(envelope, { trustedAddress: wallet.address });
    assert.equal(verified.manifest.manifestHash, values.manifest.manifestHash);
    assert.equal(verifyReleaseFiles(values.root, verified.manifest, values.paths).files.length,
      values.paths.length);
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

test("reproducible packages are byte-identical and bound to signed sources", () => {
  const values = fixture();
  try {
    const nodePaths = artifactPaths("node", values.paths);
    const first = createReleaseArtifact(values.root, nodePaths, {
      kind: "node", sourceManifest: values.manifest,
    });
    const second = createReleaseArtifact(values.root, nodePaths, {
      kind: "node", sourceManifest: values.manifest,
    });
    assert.equal(serializeReleaseArtifact(first), serializeReleaseArtifact(second));
    assert.equal(verifyReleaseArtifact(first, {
      sourceManifest: values.manifest,
    }).artifactHash, first.artifactHash);
    const tampered = structuredClone(first);
    tampered.entries[0].content = Buffer.from("different").toString("base64");
    assert.throws(() => verifyReleaseArtifact(tampered, {
      sourceManifest: values.manifest,
    }), /digest|hash/);
    const otherManifest = { ...values.manifest, sourceRevision: "b".repeat(40) };
    otherManifest.manifestHash = createReleaseManifest(values.root, values.paths, {
      releaseVersion: "0.2.0", sourceRevision: "b".repeat(40),
    }).manifestHash;
    assert.throws(() => verifyReleaseArtifact(first, {
      sourceManifest: otherManifest,
    }), /not bound/);
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});

test("browser extension ZIPs have deterministic bytes, metadata, and ordering", () => {
  const entries = [
    { contents: Buffer.from("manifest"), path: "manifest.json" },
    { contents: Buffer.from("app"), path: "app.js" },
  ];
  const first = createDeterministicZip(entries);
  const second = createDeterministicZip([...entries].reverse());
  assert.ok(first.equals(second));
  assert.equal(first.readUInt32LE(0), 0x04034b50);
  assert.equal(first.readUInt32LE(first.length - 22), 0x06054b50);
  assert.match(zipSha3(first), /^[0-9a-f]{64}$/);
  assert.throws(() => createDeterministicZip([
    ...entries, { contents: Buffer.from("duplicate"), path: "app.js" },
  ]), /unique/);
});

test("verified wallet packages install only into a new directory with provenance", () => {
  const values = fixture();
  const target = join(values.root, "installed-wallet");
  try {
    const wallet = generateWallet();
    const signedRelease = signReleaseManifest(values.manifest, wallet);
    const artifact = createReleaseArtifact(
      values.root, artifactPaths("wallet", values.paths), {
        kind: "wallet", sourceManifest: values.manifest,
      },
    );
    const provenance = installWalletArtifact(artifact, target, {
      signedRelease, trustedAddress: wallet.address,
    });
    assert.equal(readFileSync(join(target, "index.html"), "utf8"), "<h1>NIR</h1>\n");
    assert.deepEqual(JSON.parse(readFileSync(join(target, "NIR-INSTALL.json"), "utf8")),
      provenance);
    assert.equal(provenance.artifactHash, artifact.artifactHash);
    assert.equal(provenance.signerAddress, wallet.address);
    assert.deepEqual(verifyWalletInstallation(target, {
      signedRelease, trustedAddress: wallet.address,
    }), { ...provenance, files: 1, verified: true });
    const untrustedTarget = join(values.root, "untrusted-wallet");
    assert.throws(() => installWalletArtifact(artifact, untrustedTarget, {
      signedRelease, trustedAddress: generateWallet().address,
    }), /not trusted/);
    assert.equal(existsSync(untrustedTarget), false);
    assert.throws(() => installWalletArtifact(artifact, target, {
      signedRelease, trustedAddress: wallet.address,
    }), /new directory/);

    const tampered = structuredClone(artifact);
    tampered.entries[0].content = Buffer.from("tampered").toString("base64");
    const rejectedTarget = join(values.root, "rejected-wallet");
    assert.throws(() => installWalletArtifact(tampered, rejectedTarget, {
      signedRelease, trustedAddress: wallet.address,
    }), /digest|hash/);
    assert.equal(existsSync(rejectedTarget), false);

    writeFileSync(join(target, "unexpected.js"), "unexpected\n");
    assert.throws(() => verifyWalletInstallation(target, {
      signedRelease, trustedAddress: wallet.address,
    }), /file set/);
    rmSync(join(target, "unexpected.js"));
    chmodSync(join(target, "index.html"), 0o666);
    assert.throws(() => verifyWalletInstallation(target, {
      signedRelease, trustedAddress: wallet.address,
    }), /world-writable/);
    chmodSync(join(target, "index.html"), 0o644);

    writeFileSync(join(target, "index.html"), "<h1>Modified</h1>\n");
    assert.throws(() => verifyWalletInstallation(target, {
      signedRelease, trustedAddress: wallet.address,
    }), /contents differ/);
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});

test("verified node packages install and reverify an exact safe file set", () => {
  const values = fixture();
  const target = join(values.root, "installed-node");
  try {
    const wallet = generateWallet();
    const signedRelease = signReleaseManifest(values.manifest, wallet);
    const artifact = createReleaseArtifact(
      values.root, artifactPaths("node", values.paths), {
        kind: "node", sourceManifest: values.manifest,
      },
    );
    const provenance = installNodeArtifact(artifact, target, {
      signedRelease, trustedAddress: wallet.address,
    });
    assert.equal(readFileSync(join(target, "package.json"), "utf8"),
      '{"version":"0.2.0"}\n');
    assert.equal(readFileSync(join(target, "blockchain", "node.mjs"), "utf8"),
      "export const node = true;\n");
    assert.deepEqual(JSON.parse(readFileSync(join(target, "NIR-INSTALL.json"), "utf8")),
      provenance);
    assert.equal(provenance.format, "nir-node-install-v1");
    assert.deepEqual(verifyNodeInstallation(target, {
      signedRelease, trustedAddress: wallet.address,
    }), { ...provenance, files: 2, verified: true });

    const wrongKindTarget = join(values.root, "wrong-kind-node");
    const walletArtifact = createReleaseArtifact(
      values.root, artifactPaths("wallet", values.paths), {
        kind: "wallet", sourceManifest: values.manifest,
      },
    );
    assert.throws(() => installNodeArtifact(walletArtifact, wrongKindTarget, {
      signedRelease, trustedAddress: wallet.address,
    }), /node installation metadata/);
    assert.equal(existsSync(wrongKindTarget), false);
    assert.throws(() => installWalletArtifact(artifact, wrongKindTarget, {
      signedRelease, trustedAddress: wallet.address,
    }), /wallet installation metadata/);

    const untrustedTarget = join(values.root, "untrusted-node");
    assert.throws(() => installNodeArtifact(artifact, untrustedTarget, {
      signedRelease, trustedAddress: generateWallet().address,
    }), /not trusted/);
    assert.equal(existsSync(untrustedTarget), false);
    assert.throws(() => installNodeArtifact(artifact, target, {
      signedRelease, trustedAddress: wallet.address,
    }), /new directory/);

    const preservedTarget = join(values.root, "preserved-node");
    mkdirSync(preservedTarget);
    writeFileSync(join(preservedTarget, "sentinel"), "keep\n");
    assert.throws(() => installNodeArtifact(artifact, preservedTarget, {
      signedRelease, trustedAddress: wallet.address,
    }), /new directory/);
    assert.equal(readFileSync(join(preservedTarget, "sentinel"), "utf8"), "keep\n");
    assert.equal(readdirSync(values.root).some((name) => name.includes("nir-staging")), false);

    const tampered = structuredClone(artifact);
    tampered.entries[0].content = Buffer.from("tampered").toString("base64");
    const rejectedTarget = join(values.root, "rejected-node");
    assert.throws(() => installNodeArtifact(tampered, rejectedTarget, {
      signedRelease, trustedAddress: wallet.address,
    }), /digest|hash/);
    assert.equal(existsSync(rejectedTarget), false);

    writeFileSync(join(target, "unexpected.mjs"), "unexpected\n");
    assert.throws(() => verifyNodeInstallation(target, {
      signedRelease, trustedAddress: wallet.address,
    }), /file set/);
    rmSync(join(target, "unexpected.mjs"));
    chmodSync(join(target, "blockchain", "node.mjs"), 0o666);
    assert.throws(() => verifyNodeInstallation(target, {
      signedRelease, trustedAddress: wallet.address,
    }), /world-writable/);
    chmodSync(join(target, "blockchain", "node.mjs"), 0o644);
    chmodSync(join(target, "blockchain", "node.mjs"), 0o755);
    assert.throws(() => verifyNodeInstallation(target, {
      signedRelease, trustedAddress: wallet.address,
    }), /contents differ/);
    chmodSync(join(target, "blockchain", "node.mjs"), 0o644);
    chmodSync(join(target, "NIR-INSTALL.json"), 0o600);
    assert.throws(() => verifyNodeInstallation(target, {
      signedRelease, trustedAddress: wallet.address,
    }), /provenance/);
    chmodSync(join(target, "NIR-INSTALL.json"), 0o644);
    chmodSync(join(target, "blockchain"), 0o700);
    assert.throws(() => verifyNodeInstallation(target, {
      signedRelease, trustedAddress: wallet.address,
    }), /directory mode/);
    chmodSync(join(target, "blockchain"), 0o755);
    chmodSync(target, 0o755);
    assert.throws(() => verifyNodeInstallation(target, {
      signedRelease, trustedAddress: wallet.address,
    }), /directory mode/);
    chmodSync(target, 0o700);
    writeFileSync(join(target, "blockchain", "node.mjs"), "modified\n");
    assert.throws(() => verifyNodeInstallation(target, {
      signedRelease, trustedAddress: wallet.address,
    }), /contents differ/);

    rmSync(target, { recursive: true, force: true });
    installNodeArtifact(artifact, target, {
      signedRelease, trustedAddress: wallet.address,
    });
    rmSync(join(target, "blockchain", "node.mjs"));
    const identicalOutsideFile = join(values.root, "identical-node.mjs");
    writeFileSync(identicalOutsideFile, "export const node = true;\n");
    symlinkSync(identicalOutsideFile, join(target, "blockchain", "node.mjs"));
    assert.throws(() => verifyNodeInstallation(target, {
      signedRelease, trustedAddress: wallet.address,
    }), /symbolic link/);
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});

test("failed staged installation removes only its exclusive staging directory", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-release-staging-test-"));
  try {
    const wallet = generateWallet();
    const { artifact, signedRelease } = manualNodePackage(
      `blockchain/${"x".repeat(300)}`, Buffer.from("cannot materialize\n"), wallet,
    );
    const target = join(root, "node");
    assert.throws(() => installNodeArtifact(artifact, target, {
      signedRelease, trustedAddress: wallet.address,
    }), /name too long|ENAMETOOLONG/i);
    assert.equal(existsSync(target), false);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reverification fails closed when an installed directory is swapped for a symlink", () => {
  const values = fixture();
  const target = join(values.root, "swap-node");
  const moved = join(values.root, "swap-node-original");
  try {
    const wallet = generateWallet();
    const signedRelease = signReleaseManifest(values.manifest, wallet);
    const artifact = createReleaseArtifact(
      values.root, artifactPaths("node", values.paths), {
        kind: "node", sourceManifest: values.manifest,
      },
    );
    installNodeArtifact(artifact, target, {
      signedRelease, trustedAddress: wallet.address,
    });
    renameSync(target, moved);
    symlinkSync(moved, target);
    assert.throws(() => verifyNodeInstallation(target, {
      signedRelease, trustedAddress: wallet.address,
    }), /regular directory|symbolic|no-follow|ELOOP/i);
    assert.equal(readFileSync(join(moved, "package.json"), "utf8"),
      '{"version":"0.2.0"}\n');
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});

test("release CLI installs and reverifies node packages", () => {
  const values = fixture();
  const cli = new URL("../blockchain/release-cli.mjs", import.meta.url).pathname;
  const artifactPath = join(values.root, "node.nirpkg");
  const envelopePath = join(values.root, "signed-release.json");
  const target = join(values.root, "cli-node");
  try {
    const wallet = generateWallet();
    const signedRelease = signReleaseManifest(values.manifest, wallet);
    const artifact = createReleaseArtifact(
      values.root, artifactPaths("node", values.paths), {
        kind: "node", sourceManifest: values.manifest,
      },
    );
    writeFileSync(artifactPath, serializeReleaseArtifact(artifact));
    writeFileSync(envelopePath, `${JSON.stringify(signedRelease)}\n`);
    const installed = spawnSync(process.execPath, [
      cli, "install-node", artifactPath, envelopePath, wallet.address, target,
    ], { encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /Node .* installed/);
    const verified = spawnSync(process.execPath, [
      cli, "verify-node-install", target, envelopePath, wallet.address,
    ], { encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /Node .* verified/);
    writeFileSync(join(target, "package.json"), '{"version":"changed"}\n');
    const tampered = spawnSync(process.execPath, [
      cli, "verify-node-install", target, envelopePath, wallet.address,
    ], { encoding: "utf8" });
    assert.equal(tampered.status, 1);
    assert.match(tampered.stderr, /contents differ/);
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});
