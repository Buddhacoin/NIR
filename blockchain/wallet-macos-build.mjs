#!/usr/bin/env node
// Local rehearsal source build only. This is not a distributable or notarized app.
import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdtempSync, mkdirSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MODULES = Object.freeze(`
blockchain/account-history-database.mjs blockchain/account-history-index.mjs
blockchain/account-history.mjs blockchain/account-proof.mjs blockchain/account-tree.mjs
blockchain/admission-inclusion.mjs blockchain/archive-sync.mjs blockchain/asset-proof.mjs
blockchain/backup-recovery.mjs blockchain/beacon-rotation.mjs blockchain/block-store.mjs
blockchain/chain.mjs blockchain/consensus-codec.mjs blockchain/consensus-json.mjs
blockchain/constants.mjs blockchain/crypto.mjs blockchain/evaluation-assignment-tree.mjs
blockchain/http-ingress.mjs blockchain/light-client.mjs blockchain/memory.mjs
blockchain/offline-release-bundle.mjs blockchain/offline-release-governance.mjs
blockchain/offline-signer.mjs blockchain/operators.mjs blockchain/payment-request.mjs
blockchain/operator-wallet-link.mjs
blockchain/peer-registry.mjs blockchain/protocol-upgrade-authorization.mjs
blockchain/protocol-upgrade.mjs blockchain/safety-bounty.mjs blockchain/snapshot-store.mjs
blockchain/state-snapshot.mjs blockchain/transaction-simulation.mjs
blockchain/transaction-tree.mjs blockchain/transfer-state-transition.mjs
blockchain/validator-admission-omission.mjs blockchain/validator-admission-readiness-auth.mjs
blockchain/validator-admission.mjs blockchain/validator-equivocation.mjs
blockchain/validator-handoff-store.mjs blockchain/validator-handoff.mjs
blockchain/validator-onboarding.mjs blockchain/validator-recovery-store.mjs
blockchain/validator-recovery-trust-store.mjs blockchain/validator-recovery.mjs
blockchain/validator-rotation.mjs blockchain/validator-staking.mjs blockchain/vault.mjs
blockchain/wallet-backup-export-check.mjs blockchain/wallet-bridge.mjs blockchain/wallet-files.mjs blockchain/wallet-header-store.mjs
blockchain/wallet-macos-app.mjs blockchain/wallet-macos-setup.mjs
blockchain/wallet-onboarding.mjs blockchain/wallet-preview-cli.mjs
blockchain/wallet-seed.mjs
blockchain/wallet-trust-store.mjs wallet-ui/node-selection.js
`.trim().split(/\s+/));
const UI_FILES = Object.freeze(`
address-book.js app.js extension-background.js index.html manifest.json manifest.webmanifest
nir-coin-icon.png nir-coin-icon.svg node-selection.js nodes.json offline-signing.js qr.js
style.css submission-status.js sw.js transaction-decoder.js
`.trim().split(/\s+/).map((name) => `wallet-ui/${name}`));
const ASSETS = Object.freeze(["demo/wallet-nodes.local-demo.json", "package.json",
  "blockchain/bip39-english.txt", "blockchain/bip39-english-LICENSE",
  ...UI_FILES]);
const PACKAGE_FILES = Object.freeze([...new Set([...MODULES, ...ASSETS])]);
const SECRET_NAME = /\.nirvault(?:\.json)?$|\.nirkey$|\.pem$|\.key$|^\.env(?:\.|$)|(?:^|[-_.])(?:seed|secret|private)(?:[-_.].*)?\.(?:json|txt|bin|dat)$|(?:^|[-_.])(?:devnet-keys|treasury-dev-key|validator-key|coordinator-key)(?:[-_.]|$)/i;

function checkedSource(relative) {
  if (typeof relative !== "string" || relative.startsWith("/") ||
      normalize(relative) !== relative || relative.split("/").includes("..") ||
      relative.split("/").some((part) => SECRET_NAME.test(part))) {
    throw new Error("wallet bundle source path is unsafe");
  }
  let path = ROOT;
  for (const part of relative.split("/")) {
    path = join(path, part);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("wallet bundle source contains a symlink");
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) {
    throw new Error("wallet bundle source is not a bounded regular file");
  }
  return path;
}

function rejectSecretPaths() {
  for (const root of ["blockchain", "wallet-ui", "demo"]) {
    const walk = (directory) => {
      for (const name of readdirSync(join(ROOT, directory))) {
        if (SECRET_NAME.test(name)) throw new Error("secret-named path exists in wallet bundle source tree");
        const relative = join(directory, name);
        const stat = lstatSync(join(ROOT, relative));
        if (stat.isDirectory() && !stat.isSymbolicLink()) walk(relative);
      }
    };
    walk(root);
  }
}

function verifyModuleClosure() {
  const included = new Set(MODULES);
  for (const relative of MODULES) {
    const source = readFileSync(checkedSource(relative), "utf8");
    // The backup module's fixed Node built-in import is the sole reviewed
    // require() call; reject dynamic or local runtime loading.
    if (/\bimport\s*\(|\brequire\s*\(/.test(source.replace(/require\("node:http"\)/g, ""))) {
      throw new Error("dynamic wallet module loading requires a reviewed bundle update");
    }
    for (const match of source.matchAll(/(?:^|\n)import\s+(?:[\s\S]*?\s+from\s+)?["'](\.[^"']+)["']/g)) {
      const dependency = normalize(join(dirname(relative), match[1]));
      if (!included.has(dependency)) throw new Error(`wallet bundle module is missing: ${dependency}`);
    }
  }
}

function command(program, args, label) {
  const result = spawnSync(program, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr?.trim() ?? "unknown error"}`);
}

function writeIcon(resources) {
  const iconset = join(resources, "NIR.iconset");
  mkdirSync(iconset);
  const source = checkedSource("wallet-ui/nir-coin-icon.png");
  for (const [name, size] of [["icon_16x16.png", 16], ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024]]) {
    command("/usr/bin/sips", ["-z", String(size), String(size), source,
      "--out", join(iconset, name)], "icon resize");
  }
  command("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(resources, "NIR.icns")],
    "icon compilation");
  rmSync(iconset, { recursive: true });
}

export function buildMacWallet(targetPath, { sign = true } = {}) {
  if (process.platform !== "darwin") throw new Error("macOS wallet build requires macOS");
  if (Number(process.versions.node.split(".")[0]) < 26) {
    throw new Error("local wallet source build requires Node.js 26 or newer");
  }
  if (typeof targetPath !== "string" || !targetPath.startsWith("/")) {
    throw new Error("wallet app destination must be an absolute path");
  }
  const target = resolve(targetPath);
  if (basename(target) !== "NIR Wallet.app") throw new Error("destination must be NIR Wallet.app");
  const parent = dirname(target);
  if (!lstatSync(parent).isDirectory()) throw new Error("destination parent is not a directory");
  try { lstatSync(target); throw new Error("destination must be a new NIR Wallet.app path"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  rejectSecretPaths();
  verifyModuleClosure();
  for (const relative of [...PACKAGE_FILES, "macos/Info.plist", "macos/wallet-launcher.m",
    "macos/wallet-onboarding.m"]) checkedSource(relative);
  const scratch = mkdtempSync(join(parent, ".nir-wallet-build-"));
  try {
    const app = join(scratch, "NIR Wallet.app");
    const contents = join(app, "Contents");
    const resources = join(contents, "Resources");
    const payload = join(resources, "app");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(payload, { recursive: true });
    const version = JSON.parse(readFileSync(checkedSource("package.json"), "utf8")).version;
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version ?? "")) {
      throw new Error("wallet package version must be three numeric components");
    }
    const info = readFileSync(checkedSource("macos/Info.plist"), "utf8")
      .replace(/(<key>CFBundleShortVersionString<\/key><string>)[^<]+(<\/string>)/,
        (_, before, after) => `${before}${version}${after}`)
      .replace(/(<key>CFBundleVersion<\/key><string>)[^<]+(<\/string>)/,
        (_, before, after) => `${before}${version}${after}`);
    writeFileSync(join(contents, "Info.plist"), info);
    writeFileSync(join(resources, "NIR-LOCAL-BUILD.json"),
      '{"format":"nir-local-test-build-v1","distribution":"not-a-public-installer"}\n');
    writeFileSync(join(resources, "NIR-RUNTIME.json"),
      `${JSON.stringify({ nodeExecutable: process.execPath })}\n`);
    writeIcon(resources);
    for (const [source, name] of [["macos/wallet-launcher.m", "launcher"],
      ["macos/wallet-onboarding.m", "onboarding"]]) {
      command("/usr/bin/clang", ["-fobjc-arc", "-framework", "AppKit", "-framework",
        "Foundation", checkedSource(source), "-o", join(contents, "MacOS", name)],
      `native ${name} build`);
    }
    for (const relative of PACKAGE_FILES) {
      const destination = join(payload, relative);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(checkedSource(relative), destination);
    }
    if (sign) {
      command("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app], "ad-hoc signing");
      command("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], "signature check");
    }
    renameSync(app, target);
    return target;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: wallet:macos-build /absolute/path/NIR Wallet.app");
    process.stdout.write(`${buildMacWallet(process.argv[2])}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
