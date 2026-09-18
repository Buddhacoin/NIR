import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson, generateWallet } from "../blockchain/crypto.mjs";
import {
  createOfflineReleaseBundle, parseOfflineReleaseBundle, serializeOfflineReleaseApproval,
  parseOfflineReleaseApproval, serializeOfflineReleaseBundle, signOfflineReleaseBundle,
  validateOfflineReleaseApproval, verifyOfflineReleaseGitTree,
  validateOfflineReleaseBundle,
} from "../blockchain/offline-release-bundle.mjs";
import { decryptWallet, encryptWallet } from "../blockchain/vault.mjs";

const REVISION = "a".repeat(40);
const CONTEXT = Object.freeze({
  networkId: "nir-release-test", previousBundleHash: null, protocolVersion: 24,
  releaseVersion: "1.2.3", sourceRevision: REVISION,
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-offline-release-"));
  mkdirSync(join(root, "bin"), { mode: 0o755 });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "fixture", private: true, scripts: { test: "node --test" }, type: "module",
    version: "1.2.3",
  }, null, 2)}\n`);
  writeFileSync(join(root, "README.md"), "deterministic release\n");
  writeFileSync(join(root, "bin", "run.mjs"), "console.log('offline');\n");
  chmodSync(join(root, "bin", "run.mjs"), 0o755);
  return { paths: ["README.md", "bin/run.mjs", "package.json"], root };
}

function signedFixture(values) {
  const bundle = createOfflineReleaseBundle(values.root, values.paths, CONTEXT);
  const releaseWallet = generateWallet();
  const encrypted = encryptWallet(releaseWallet, "release-key-password-long");
  releaseWallet.privateKey = "";
  const unlocked = decryptWallet(encrypted, "release-key-password-long");
  try {
    return { approval: signOfflineReleaseBundle(bundle, unlocked), bundle, releaseWallet: unlocked };
  } finally {
    unlocked.privateKey = "";
  }
}

test("offline release payload is reproducible and binds exact files and update context", () => {
  const values = fixture();
  try {
    const first = createOfflineReleaseBundle(values.root, values.paths, CONTEXT);
    const second = createOfflineReleaseBundle(values.root, [...values.paths].reverse(), CONTEXT);
    assert.equal(serializeOfflineReleaseBundle(first), serializeOfflineReleaseBundle(second));
    assert.equal(first.manifest.releaseVersion, "1.2.3");
    assert.equal(first.manifest.networkId, "nir-release-test");
    assert.equal(first.manifest.protocolVersion, 24);
    assert.equal(first.manifest.previousBundleHash, null);
    assert.deepEqual(first.manifest.files.map(({ path }) => path),
      ["README.md", "bin/run.mjs", "package.json"]);
    assert.equal(first.manifest.files.find(({ path }) => path === "bin/run.mjs").mode, 0o755);
    assert.equal(first.manifest.files.find(({ path }) => path === "README.md").mode, 0o644);
    assert.deepEqual(parseOfflineReleaseBundle(serializeOfflineReleaseBundle(first)), first);
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});

test("encrypted ML-DSA release key signs a detached context-checked approval", () => {
  const values = fixture();
  try {
    const { approval, bundle, releaseWallet } = signedFixture(values);
    const verified = validateOfflineReleaseApproval(bundle, approval, {
      ...CONTEXT, trustedAddress: releaseWallet.address,
    });
    assert.equal(verified.bundle.bundleHash, bundle.bundleHash);
    assert.equal(JSON.stringify(approval).includes("privateKey"), false);
    assert.equal(JSON.stringify(approval).includes("password"), false);
    for (const changed of [
      { networkId: "nir-other" }, { protocolVersion: 25 }, { releaseVersion: "1.2.4" },
      { previousBundleHash: `sha3-256:${"b".repeat(64)}` },
    ]) {
      assert.throws(() => validateOfflineReleaseApproval(bundle, approval, {
        ...CONTEXT, ...changed, trustedAddress: releaseWallet.address,
      }), /expected update context/);
    }
    assert.throws(() => validateOfflineReleaseApproval(bundle, approval, {
      ...CONTEXT, trustedAddress: generateWallet().address,
    }), /invalid or untrusted/);
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});

test("tampering with contents, manifest, signer, modes, or unknown fields fails closed", () => {
  const values = fixture();
  try {
    const { approval, bundle, releaseWallet } = signedFixture(values);
    const mutations = [
      (copy) => { copy.entries[0].content = Buffer.from("changed\n").toString("base64"); },
      (copy) => { copy.manifest.files[0].mode = 0o777; },
      (copy) => { copy.manifest.files[0].size += 1; },
      (copy) => { copy.manifest.networkId = "nir-other"; },
      (copy) => { copy.extra = true; },
      (copy) => { copy.entries[0].extra = true; },
      (copy) => { copy.manifest.files[0].extra = true; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(bundle); mutate(changed);
      assert.throws(() => validateOfflineReleaseBundle(changed));
    }
    const changedApproval = structuredClone(approval);
    changedApproval.signature = `${changedApproval.signature.slice(0, -4)}AAAA`;
    assert.throws(() => validateOfflineReleaseApproval(bundle, changedApproval, {
      ...CONTEXT, trustedAddress: releaseWallet.address,
    }), /invalid or untrusted/);
    const unknownApproval = { ...approval, extra: true };
    assert.throws(() => validateOfflineReleaseApproval(bundle, unknownApproval, {
      ...CONTEXT, trustedAddress: releaseWallet.address,
    }), /unknown or missing/);
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});

test("canonical parser rejects duplicate JSON keys, whitespace, and non-canonical base64", () => {
  const values = fixture();
  try {
    const bundle = createOfflineReleaseBundle(values.root, values.paths, CONTEXT);
    const canonical = serializeOfflineReleaseBundle(bundle).trimEnd();
    assert.throws(() => parseOfflineReleaseBundle(` ${canonical}`), /not canonical/);
    assert.throws(() => parseOfflineReleaseBundle(`${canonical}\n\n`), /not canonical/);
    const duplicate = canonical.replace('{"bundleHash":', '{"bundleHash":"sha3-256:' +
      `${"0".repeat(64)}","bundleHash":`);
    assert.throws(() => parseOfflineReleaseBundle(duplicate), /not canonical/);
    const changed = structuredClone(bundle);
    changed.entries[0].content += "=";
    changed.bundleHash = bundle.bundleHash;
    assert.throws(() => validateOfflineReleaseBundle(changed), /canonical base64/);
    const releaseWallet = generateWallet();
    const approval = signOfflineReleaseBundle(bundle, releaseWallet);
    const approvalText = serializeOfflineReleaseApproval(bundle, approval).trimEnd();
    assert.throws(() => parseOfflineReleaseApproval(` ${approvalText}`, bundle, {
      trustedAddress: releaseWallet.address,
    }), /not canonical/);
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});

test("create CLI binds a clean tracked Git revision and refuses a dirty tree", () => {
  const values = fixture();
  const pathsPath = join(values.root, "..", `paths-${Date.now()}.json`);
  const output = join(values.root, "..", `bundle-${Date.now()}.json`);
  const dirtyOutput = `${output}.dirty`;
  try {
    execFileSync("git", ["-C", values.root, "init", "-q"]);
    execFileSync("git", ["-C", values.root, "config", "user.email", "release-test@invalid"]);
    execFileSync("git", ["-C", values.root, "config", "user.name", "Release Test"]);
    execFileSync("git", ["-C", values.root, "add", "."]);
    execFileSync("git", ["-C", values.root, "commit", "-qm", "fixture"]);
    const revision = execFileSync("git", ["-C", values.root, "rev-parse", "HEAD"],
      { encoding: "utf8" }).trim();
    writeFileSync(pathsPath, JSON.stringify(values.paths));
    const cli = new URL("../blockchain/offline-release-cli.mjs", import.meta.url).pathname;
    const created = execFileSync(process.execPath, [cli, "create", values.root, pathsPath,
      "1.2.3", "nir-release-test", "24", revision, output, "none"], { encoding: "utf8" });
    assert.match(created, /created for 3 files/);
    assert.equal(parseOfflineReleaseBundle(readFileSync(output, "utf8")).manifest.sourceRevision,
      revision);
    writeFileSync(join(values.root, "README.md"), "dirty\n");
    const raced = createOfflineReleaseBundle(values.root, values.paths, {
      ...CONTEXT, sourceRevision: revision,
    });
    assert.throws(() => verifyOfflineReleaseGitTree(values.root, raced, revision),
      /does not match Git revision/);
    const rejected = spawnSync(process.execPath, [cli, "create", values.root, pathsPath,
      "1.2.3", "nir-release-test", "24", revision, dirtyOutput, "none"], { encoding: "utf8" });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /not clean/);
  } finally {
    rmSync(values.root, { recursive: true, force: true });
    rmSync(pathsPath, { force: true });
    rmSync(output, { force: true });
    rmSync(dirtyOutput, { force: true });
  }
});

test("source traversal, symlink, hardlink, case collision and Unicode ambiguity are rejected", () => {
  const values = fixture();
  try {
    assert.throws(() => createOfflineReleaseBundle(values.root, ["../secret"], CONTEXT), /unsafe|invalid/);
    assert.throws(() => createOfflineReleaseBundle(values.root, ["README.md", "readme.md"], CONTEXT),
      /duplicate or ambiguous/);
    assert.throws(() => createOfflineReleaseBundle(values.root, ["cafe\u0301.txt"], CONTEXT), /invalid/);
    symlinkSync("README.md", join(values.root, "linked"));
    assert.throws(() => createOfflineReleaseBundle(values.root, ["linked"], CONTEXT), /regular file/);
    linkSync(join(values.root, "README.md"), join(values.root, "hardlinked"));
    assert.throws(() => createOfflineReleaseBundle(values.root, ["README.md"], CONTEXT), /unique/);
    rmSync(join(values.root, "hardlinked"));
    mkdirSync(join(values.root, "outside"));
    symlinkSync("outside", join(values.root, "redirect"), "dir");
    assert.throws(() => createOfflineReleaseBundle(values.root, ["redirect/file"], CONTEXT), /unsafe/);
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});

test("secret-bearing paths and contents never enter a release bundle", () => {
  const values = fixture();
  try {
    writeFileSync(join(values.root, ".env"), "TOKEN=secret\n");
    assert.throws(() => createOfflineReleaseBundle(values.root, [".env"], CONTEXT), /unsafe/);
    writeFileSync(join(values.root, "release.pem"), "secret");
    assert.throws(() => createOfflineReleaseBundle(values.root, ["release.pem"], CONTEXT), /unsafe/);
    writeFileSync(join(values.root, "innocent.txt"),
      "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n");
    assert.throws(() => createOfflineReleaseBundle(values.root, ["innocent.txt"], CONTEXT),
      /private-key material/);
    writeFileSync(join(values.root, "secret.json"), JSON.stringify({ privateKey: "not-real" }));
    assert.throws(() => createOfflineReleaseBundle(values.root, ["secret.json"], CONTEXT),
      /secret-bearing JSON/);
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});

test("source mutation during descriptor-bound read is detected", () => {
  const values = fixture();
  try {
    let mutated = false;
    assert.throws(() => createOfflineReleaseBundle(values.root, values.paths, {
      ...CONTEXT,
      _afterFileOpen({ relativePath }) {
        if (!mutated && relativePath === "README.md") {
          mutated = true;
          writeFileSync(join(values.root, "README.md"), "mutated during read\n");
        }
      },
    }), /changed during read/);
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});

test("npm lifecycle scripts, ranges, missing locks and scripted lock entries are rejected", () => {
  const values = fixture();
  try {
    const packagePath = join(values.root, "package.json");
    writeFileSync(packagePath, JSON.stringify({
      name: "bad", scripts: { postinstall: "curl invalid" }, version: "1.2.3",
    }));
    assert.throws(() => createOfflineReleaseBundle(values.root, ["package.json"], CONTEXT),
      /lifecycle script/);
    writeFileSync(packagePath, JSON.stringify({
      dependencies: { dep: "^1.2.3" }, name: "bad", version: "1.2.3",
    }));
    assert.throws(() => createOfflineReleaseBundle(values.root, ["package.json"], CONTEXT),
      /exact registry versions/);
    writeFileSync(packagePath, JSON.stringify({
      dependencies: { dep: "1.2.3" }, name: "bad", version: "1.2.3",
    }));
    assert.throws(() => createOfflineReleaseBundle(values.root, ["package.json"], CONTEXT),
      /package lock/);
    writeFileSync(packagePath, JSON.stringify({
      dependencies: { dep: "1.2.3" }, devDependencies: { dep: "1.2.3" },
      name: "bad", version: "1.2.3",
    }));
    writeFileSync(join(values.root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3,
      packages: { "": { dependencies: { dep: "1.2.3" }, devDependencies: { dep: "1.2.3" } } } }));
    assert.throws(() => createOfflineReleaseBundle(values.root,
      ["package-lock.json", "package.json"], CONTEXT), /multiple package sections/);
    writeFileSync(packagePath, JSON.stringify({
      dependencies: { dep: "1.2.3" }, name: "bad", version: "1.2.3",
    }));
    writeFileSync(join(values.root, "package-lock.json"), JSON.stringify({
      lockfileVersion: 3, packages: { "": { dependencies: { dep: "1.2.3" } } },
    }));
    assert.throws(() => createOfflineReleaseBundle(values.root,
      ["package-lock.json", "package.json"], CONTEXT), /missing a root dependency/);
    writeFileSync(join(values.root, "package-lock.json"), JSON.stringify({
      lockfileVersion: 3, packages: {
        "": { dependencies: { dep: "1.2.3" } },
        "node_modules/dep": { integrity: "sha512-A", resolved:
          "https://registry.npmjs.org/dep/-/dep-1.2.3.tgz", version: "1.2.3" },
      },
    }));
    assert.throws(() => createOfflineReleaseBundle(values.root,
      ["package-lock.json", "package.json"], CONTEXT), /unpinned or scripted/);
    writeFileSync(join(values.root, "package-lock.json"), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { dep: "1.2.3" } },
        "node_modules/dep": {
          hasInstallScript: true, integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
          resolved: "https://registry.npmjs.org/dep/-/dep-1.2.3.tgz", version: "1.2.3",
        },
      },
    }));
    assert.throws(() => createOfflineReleaseBundle(values.root,
      ["package-lock.json", "package.json"], CONTEXT), /scripted package/);
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});

test("strict offline verify CLI accepts exact context and rejects stale context", () => {
  const values = fixture();
  const bundlePath = join(values.root, "release.nirbundle");
  const approvalPath = join(values.root, "release.approval.json");
  try {
    const { approval, bundle, releaseWallet } = signedFixture(values);
    writeFileSync(bundlePath, serializeOfflineReleaseBundle(bundle));
    writeFileSync(approvalPath, serializeOfflineReleaseApproval(bundle, approval));
    const cli = new URL("../blockchain/offline-release-cli.mjs", import.meta.url).pathname;
    const ok = execFileSync(process.execPath, [cli, "verify", bundlePath, approvalPath,
      releaseWallet.address, "1.2.3", "nir-release-test", "24", "none", bundle.bundleHash],
    { encoding: "utf8" });
    assert.match(ok, /verified/);
    const stale = spawnSync(process.execPath, [cli, "verify", bundlePath, approvalPath,
      releaseWallet.address, "1.2.3", "nir-release-test", "25", "none", bundle.bundleHash],
    { encoding: "utf8" });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /expected update context/);
    assert.equal(stale.stderr.includes("privateKey"), false);
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});
