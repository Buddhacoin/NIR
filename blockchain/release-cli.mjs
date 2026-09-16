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

import {
  createReleaseManifest,
  signReleaseManifest,
  verifyReleaseFiles,
  verifySignedRelease,
} from "./release-manifest.mjs";
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

function readBoundedJson(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 * 1024) {
    throw new Error("release input must be a bounded regular file");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function trackedFiles(root) {
  return execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter(Boolean).sort();
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
  const target = resolve(path);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
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
  } else {
    throw new Error("usage: release:create <repo> <manifest.json> | release:sign <manifest.json> <release-vault> <signed.json> | release:verify <repo> <signed.json> <trusted-address>");
  }
} catch (error) {
  console.error(`Release operation failed: ${error.message}`);
  process.exitCode = 1;
}
