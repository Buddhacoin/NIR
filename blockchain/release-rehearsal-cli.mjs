#!/usr/bin/env node
/** Exercise the public, valueless .nirpkg release path on the current host. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateWallet } from "./crypto.mjs";
import { signReleaseManifest } from "./release-manifest.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseCli = join(sourceRoot, "blockchain", "release-cli.mjs");
const temporary = mkdtempSync(join(tmpdir(), "nir-release-rehearsal-"));

function release(...args) {
  return execFileSync(process.execPath, [releaseCli, ...args], {
    cwd: sourceRoot, encoding: "utf8", maxBuffer: 1024 * 1024,
  }).trim();
}

function sha3(path) {
  return createHash("sha3-256").update(readFileSync(path)).digest("hex");
}

try {
  const manifestPath = join(temporary, "manifest.json");
  const signedPath = join(temporary, "signed-release.json");
  release("create", sourceRoot, manifestPath);
  const wallet = generateWallet();
  const trustedAddress = wallet.address;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(signedPath, `${JSON.stringify(signReleaseManifest(manifest, wallet))}\n`, {
      flag: "wx", mode: 0o600,
    });
  } finally {
    wallet.privateKey = "";
  }
  release("verify", sourceRoot, signedPath, trustedAddress);

  for (const kind of ["node", "wallet"]) {
    const first = join(temporary, `${kind}-first.nirpkg`);
    const second = join(temporary, `${kind}-second.nirpkg`);
    const installed = join(temporary, `${kind}-installed`);
    release("build", kind, sourceRoot, signedPath, trustedAddress, first);
    release("build", kind, sourceRoot, signedPath, trustedAddress, second);
    const firstBytes = readFileSync(first);
    const secondBytes = readFileSync(second);
    assert.ok(firstBytes.equals(secondBytes), `${kind} builds differ byte-for-byte`);
    const artifact = JSON.parse(firstBytes.toString("utf8"));
    assert.equal(artifact.artifactHash, JSON.parse(secondBytes.toString("utf8")).artifactHash);
    release("verify-artifact", first, signedPath, trustedAddress);
    release(`install-${kind}`, first, signedPath, trustedAddress, installed);
    release(`verify-${kind}-install`, installed, signedPath, trustedAddress);

    const installedPath = kind === "wallet"
      ? artifact.entries[0].path.slice("wallet-ui/".length)
      : artifact.entries[0].path;
    const tamperPath = join(installed, ...installedPath.split("/"));
    writeFileSync(tamperPath, "NIR release rehearsal tamper\n");
    const rejected = spawnSync(process.execPath, [
      releaseCli, `verify-${kind}-install`, installed, signedPath, trustedAddress,
    ], { cwd: sourceRoot, encoding: "utf8" });
    assert.equal(rejected.status, 1, `${kind} tampered install was accepted`);
    assert.match(rejected.stderr, /contents differ|digest|hash/i,
      `${kind} verification failed for an unrelated reason`);
    console.log(`${kind}: deterministic ${sha3(first)}; fresh install verified; tamper rejected`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
