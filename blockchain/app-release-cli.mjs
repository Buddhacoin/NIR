#!/usr/bin/env node
// The owner's release commands (docs/app-updates.md):
//   npm run app-release:key  -- [key file]   once: create the release key, pin it
//   npm run app-release:sign -- [key file]   per release: sign origin/main, push
// The key file is an encrypted wallet vault and never leaves this computer.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createSourceRelease, SOURCE_RELEASE_PATH, verifySourceRelease } from "./source-release.mjs";
import { decryptWallet } from "./vault.mjs";
import { createWalletFile, walletPublicInfo } from "./wallet-files.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_KEY = join(homedir(), ".nir", "release-signer.nirvault.json");
const PINNED = /^export const pinnedUpdateSignerAddress = (null|"nir1[0-9a-f]{64}");$/m;

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function readSecret(prompt) {
  if (process.env.NIR_RELEASE_PASSWORD !== undefined) return Promise.resolve(process.env.NIR_RELEASE_PASSWORD);
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

export function pinnedSignerInSource(root = ROOT) {
  const match = PINNED.exec(readFileSync(join(root, "blockchain", "update-trust-anchor.mjs"), "utf8"));
  if (!match) throw new Error("update-trust-anchor.mjs has no recognizable pinned signer");
  return match[1] === "null" ? null : JSON.parse(match[1]);
}

export function pinSignerInSource(address, root = ROOT) {
  const path = join(root, "blockchain", "update-trust-anchor.mjs");
  const source = readFileSync(path, "utf8");
  if (!PINNED.test(source)) throw new Error("update-trust-anchor.mjs has no recognizable pinned signer");
  writeFileSync(path, source.replace(PINNED, `export const pinnedUpdateSignerAddress = ${JSON.stringify(address)};`));
}

export async function createKey(keyPath, root = ROOT) {
  if (existsSync(keyPath)) throw new Error(`${keyPath} already exists; it is your release key`);
  const pinned = pinnedSignerInSource(root);
  if (pinned !== null) {
    throw new Error(`a release signer is already pinned (${pinned}); changing it needs a release signed by that key`);
  }
  const password = await readSecret("New release key password (at least 12 characters): ");
  if (password.length < 12) throw new Error("use a password of at least 12 characters");
  if (process.env.NIR_RELEASE_PASSWORD === undefined &&
      await readSecret("Repeat the password: ") !== password) throw new Error("passwords differ");
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  const { address } = createWalletFile({ label: "NIR release signer", password, path: keyPath });
  pinSignerInSource(address, root);
  return [
    `Release key: ${keyPath}`,
    `Signer address: ${address}`,
    "",
    "The address is now pinned in blockchain/update-trust-anchor.mjs. Next:",
    "  1. Back up the key file and its password somewhere other than this Mac.",
    "  2. Commit and push this change to main.",
    "  3. Build NIR Wallet and NIR Model Lab once by hand from that commit.",
    "From then on the apps' Update button installs only releases signed by this key.",
  ].join("\n");
}

export async function signRelease(keyPath, root = ROOT) {
  const signer = walletPublicInfo(keyPath).address;
  if (git(root, "status", "--porcelain") !== "") throw new Error("commit or discard local changes first");
  git(root, "fetch", "--quiet", "origin", "main");
  const revision = git(root, "rev-parse", "FETCH_HEAD");
  if (git(root, "rev-parse", "HEAD") !== revision) {
    throw new Error("check out origin/main first: a release is always the current main");
  }
  // The pinned signer at this revision is the one later releases are checked
  // against; a release must not orphan its own key.
  if (pinnedSignerInSource(root) !== signer) {
    throw new Error("this key is not the signer pinned in blockchain/update-trust-anchor.mjs");
  }
  let sequence = 1;
  const releasePath = join(root, SOURCE_RELEASE_PATH);
  if (existsSync(releasePath)) {
    const previous = verifySourceRelease(JSON.parse(readFileSync(releasePath, "utf8")), { trustedAddress: signer });
    // Only the release file changed since the last release: nothing to ship.
    const changed = git(root, "diff", "--name-only", previous.sourceRevision, revision, "--", ".",
      `:(exclude)${SOURCE_RELEASE_PATH}`);
    if (changed === "") throw new Error("nothing changed since the last release; it is already released");
    sequence = previous.sequence + 1;
  }
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const password = await readSecret(`Release key password (${signer.slice(0, 12)}…): `);
  const wallet = decryptWallet(JSON.parse(readFileSync(keyPath, "utf8")), password);
  let envelope;
  try {
    envelope = createSourceRelease({ wallet, sequence, sourceRevision: revision, version });
  } finally {
    wallet.privateKey = "";
  }
  mkdirSync(dirname(releasePath), { recursive: true });
  writeFileSync(releasePath, `${JSON.stringify(envelope, null, 2)}\n`);
  git(root, "add", SOURCE_RELEASE_PATH);
  git(root, "commit", "--quiet", "-m", `Release ${version} (${sequence})`, "-m",
    `Signed source release of ${revision}.`);
  git(root, "push", "--quiet", "origin", "HEAD:main");
  return `Released ${version} (sequence ${sequence}, ${revision.slice(0, 12)}). The apps can now update.`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, keyPath = DEFAULT_KEY] = process.argv.slice(2);
  const run = command === "key" ? createKey : command === "sign" ? signRelease : null;
  if (!run) {
    process.stderr.write("usage: app-release-cli.mjs key|sign [key file]\n");
    process.exitCode = 2;
  } else {
    run(resolve(keyPath)).then((message) => process.stdout.write(`${message}\n`), (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
