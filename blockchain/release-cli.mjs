#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import process from "node:process";

import { canonicalJson } from "./crypto.mjs";
import { createDeterministicZip, zipSha3 } from "./deterministic-zip.mjs";
import {
  createReleaseManifest,
  signReleaseManifest,
  verifyReleaseFiles,
  verifySignedRelease,
} from "./release-manifest.mjs";
import {
  artifactPaths,
  createReleaseArtifact,
  inventoryNodeInstallations,
  inventoryWalletInstallations,
  installNodeArtifact,
  installWalletArtifact,
  pruneNodeInstallationGeneration,
  pruneWalletInstallationGeneration,
  serializeReleaseArtifact,
  verifyReleaseArtifact,
  verifyNodeInstallation,
  verifyWalletInstallation,
} from "./release-artifact.mjs";
import { decryptWallet } from "./vault.mjs";

function readSecret(prompt) {
  return new Promise((resolveSecret, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      reject(new Error("secure password entry requires an interactive terminal")); return;
    }
    process.stdout.write(prompt);
    let value = "";
    const finish = (error) => {
      process.stdin.off("data", onData); process.stdin.setRawMode(false);
      process.stdin.pause(); process.stdout.write("\n");
      error ? reject(error) : resolveSecret(value);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", onData);
  });
}

function readBoundedJson(path, maximumBytes = 16 * 1024 * 1024) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    throw new Error("release input must be a bounded regular file");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function trackedFiles(root) {
  return execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter(Boolean).sort();
}

function extensionZip(root, manifest, paths) {
  const artifact = createReleaseArtifact(root, artifactPaths("wallet", paths), {
    kind: "wallet", sourceManifest: manifest,
  });
  const entries = artifact.entries.map((entry) => ({
    contents: Buffer.from(entry.content, "base64"),
    executable: entry.executable,
    path: entry.path.slice("wallet-ui/".length),
  }));
  entries.push({
    contents: Buffer.from(`${canonicalJson({
      artifactHash: artifact.artifactHash,
      format: "nir-extension-release-v1",
      sourceManifestHash: artifact.sourceManifestHash,
      sourceRevision: artifact.sourceRevision,
    })}\n`),
    executable: false,
    path: "NIR-RELEASE.json",
  });
  return createDeterministicZip(entries);
}

function revision(root) {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function requireCleanTrackedTree(root) {
  const status = execFileSync(
    "git", ["-C", root, "status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (status !== "") throw new Error("tracked source tree must be clean before release creation");
}

function writeAtomic(path, value) {
  writeAtomicContents(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeAtomicContents(path, contents) {
  const target = resolve(path);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o644);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "create" && args.length === 2) {
    const [rootValue, output] = args;
    const root = resolve(rootValue);
    requireCleanTrackedTree(root);
    const paths = trackedFiles(root);
    const outputRelative = relative(root, resolve(output)).split("\\").join("/");
    if (paths.includes(outputRelative)) throw new Error("manifest output cannot be a tracked source file");
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const manifest = createReleaseManifest(root, paths, {
      releaseVersion: packageJson.version,
      sourceRevision: revision(root),
    });
    writeAtomic(output, manifest);
    console.log(`Release manifest ${manifest.manifestHash} created for ${paths.length} files.`);
  } else if (command === "sign" && args.length === 3) {
    const [manifestPath, vaultPath, output] = args;
    const password = await readSecret("Release vault password: ");
    const wallet = decryptWallet(readBoundedJson(vaultPath), password);
    try {
      const envelope = signReleaseManifest(readBoundedJson(manifestPath), wallet);
      writeAtomic(output, envelope);
      console.log(`Release signed by ${wallet.address}.`);
    } finally {
      wallet.privateKey = "";
    }
  } else if (command === "verify" && args.length === 3) {
    const [rootValue, envelopePath, trustedAddress] = args;
    const root = resolve(rootValue);
    const envelope = readBoundedJson(envelopePath);
    const { manifest, signer } = verifySignedRelease(envelope, { trustedAddress });
    if (manifest.sourceRevision !== revision(root)) {
      throw new Error("checked-out revision does not match the signed release");
    }
    verifyReleaseFiles(root, manifest, trackedFiles(root));
    console.log(`Release ${manifest.manifestHash} verified for signer ${signer.address}.`);
  } else if (command === "build" && args.length === 5) {
    const [kind, rootValue, envelopePath, trustedAddress, output] = args;
    const root = resolve(rootValue);
    requireCleanTrackedTree(root);
    const envelope = readBoundedJson(envelopePath);
    const { manifest } = verifySignedRelease(envelope, { trustedAddress });
    if (manifest.sourceRevision !== revision(root)) {
      throw new Error("checked-out revision does not match the signed release");
    }
    const paths = trackedFiles(root);
    verifyReleaseFiles(root, manifest, paths);
    const artifact = createReleaseArtifact(root, artifactPaths(kind, paths), {
      kind, sourceManifest: manifest,
    });
    writeAtomicContents(output, serializeReleaseArtifact(artifact));
    console.log(`${kind} artifact ${artifact.artifactHash} created.`);
  } else if (command === "verify-artifact" && args.length === 3) {
    const [artifactPath, envelopePath, trustedAddress] = args;
    const { manifest, signer } = verifySignedRelease(readBoundedJson(envelopePath), {
      trustedAddress,
    });
    const artifact = verifyReleaseArtifact(
      readBoundedJson(artifactPath, 520 * 1024 * 1024), { sourceManifest: manifest },
    );
    console.log(`${artifact.kind} artifact ${artifact.artifactHash} verified for ${signer.address}.`);
  } else if (command === "install-wallet" && args.length === 4) {
    const [artifactPath, envelopePath, trustedAddress, target] = args;
    const provenance = installWalletArtifact(
      readBoundedJson(artifactPath, 520 * 1024 * 1024), target, {
        signedRelease: readBoundedJson(envelopePath), trustedAddress,
      },
    );
    console.log(`Wallet ${provenance.artifactHash} installed at ${resolve(target)}.`);
  } else if (command === "verify-wallet-install" && args.length === 3) {
    const [target, envelopePath, trustedAddress] = args;
    const result = verifyWalletInstallation(target, {
      signedRelease: readBoundedJson(envelopePath), trustedAddress,
    });
    console.log(`Wallet ${result.artifactHash} verified at ${resolve(target)}.`);
  } else if (command === "install-node" && args.length === 4) {
    const [artifactPath, envelopePath, trustedAddress, target] = args;
    const provenance = installNodeArtifact(
      readBoundedJson(artifactPath, 520 * 1024 * 1024), target, {
        signedRelease: readBoundedJson(envelopePath), trustedAddress,
      },
    );
    console.log(`Node ${provenance.artifactHash} installed at ${resolve(target)}.`);
  } else if (command === "verify-node-install" && args.length === 3) {
    const [target, envelopePath, trustedAddress] = args;
    const result = verifyNodeInstallation(target, {
      signedRelease: readBoundedJson(envelopePath), trustedAddress,
    });
    console.log(`Node ${result.artifactHash} verified at ${resolve(target)}.`);
  } else if ((command === "inventory-wallet" || command === "inventory-node") &&
      args.length === 3) {
    const [target, envelopePath, trustedAddress] = args;
    const options = { signedRelease: readBoundedJson(envelopePath), trustedAddress };
    const result = command === "inventory-wallet"
      ? inventoryWalletInstallations(target, options)
      : inventoryNodeInstallations(target, options);
    console.log(JSON.stringify(result, null, 2));
  } else if ((command === "prune-wallet-generation" || command === "prune-node-generation") &&
      (args.length === 5 || args.length === 6)) {
    const [target, generation, artifactHash, envelopePath, trustedAddress, execute] = args;
    if (execute !== undefined && execute !== "--execute") {
      throw new Error("generation prune accepts only the optional --execute flag");
    }
    const options = {
      dryRun: execute !== "--execute",
      signedRelease: readBoundedJson(envelopePath),
      trustedAddress,
    };
    const result = command === "prune-wallet-generation"
      ? pruneWalletInstallationGeneration(target, generation, artifactHash, options)
      : pruneNodeInstallationGeneration(target, generation, artifactHash, options);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "build-extension" && args.length === 4) {
    const [rootValue, envelopePath, trustedAddress, output] = args;
    const root = resolve(rootValue);
    requireCleanTrackedTree(root);
    const { manifest } = verifySignedRelease(readBoundedJson(envelopePath), { trustedAddress });
    if (manifest.sourceRevision !== revision(root)) {
      throw new Error("checked-out revision does not match the signed release");
    }
    const paths = trackedFiles(root);
    verifyReleaseFiles(root, manifest, paths);
    const zip = extensionZip(root, manifest, paths);
    writeAtomicContents(output, zip);
    console.log(`Browser extension ${zipSha3(zip)} created.`);
  } else if (command === "verify-extension" && args.length === 4) {
    const [rootValue, envelopePath, trustedAddress, archivePath] = args;
    const root = resolve(rootValue);
    requireCleanTrackedTree(root);
    const { manifest } = verifySignedRelease(readBoundedJson(envelopePath), { trustedAddress });
    if (manifest.sourceRevision !== revision(root)) {
      throw new Error("checked-out revision does not match the signed release");
    }
    const paths = trackedFiles(root);
    verifyReleaseFiles(root, manifest, paths);
    const expected = extensionZip(root, manifest, paths);
    const actualMetadata = lstatSync(archivePath);
    if (!actualMetadata.isFile() || actualMetadata.isSymbolicLink() ||
        actualMetadata.size > 520 * 1024 * 1024 ||
        !expected.equals(readFileSync(archivePath))) {
      throw new Error("browser extension does not match the reproducible build");
    }
    console.log(`Browser extension ${zipSha3(expected)} verified.`);
  } else {
    throw new Error("usage: release:create <repo> <manifest.json> | release:sign <manifest.json> <release-vault> <signed.json> | release:verify <repo> <signed.json> <trusted-address> | release:build <wallet|node> <repo> <signed.json> <trusted-address> <artifact.nirpkg> | release:verify-artifact <artifact.nirpkg> <signed.json> <trusted-address> | release:install-wallet <wallet.nirpkg> <signed.json> <trusted-address> <new-directory> | release:verify-wallet-install <installed-directory> <signed.json> <trusted-address> | release:install-node <node.nirpkg> <signed.json> <trusted-address> <new-directory> | release:verify-node-install <installed-directory> <signed.json> <trusted-address> | release:inventory-<wallet|node> <installed-target> <signed.json> <trusted-address> | release:prune-<wallet|node>-generation <installed-target> <exact-generation> <artifact-hash> <signed.json> <trusted-address> [--execute] | release:build-extension <repo> <signed.json> <trusted-address> <extension.zip> | release:verify-extension <repo> <signed.json> <trusted-address> <extension.zip>");
  }
} catch (error) {
  console.error(`Release operation failed: ${error.message}`);
  process.exitCode = 1;
}
