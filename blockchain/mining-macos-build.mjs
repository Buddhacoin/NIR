#!/usr/bin/env node
// Local tester source build only: no bundled runtime, notarization, or public release.
import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdtempSync, mkdirSync, readFileSync,
  renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createRuntimeBinding } from "./local-runtime-binding.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FILES = Object.freeze(`
package.json blockchain/mining-practice-app-cli.mjs blockchain/mining-practice-app.mjs
blockchain/iris-linear-candidate.mjs examples/iris_integer_linear.json
blockchain/operator-wallet-link.mjs blockchain/crypto.mjs blockchain/consensus-codec.mjs blockchain/constants.mjs
blockchain/open-model-catalog.mjs mining-app/index.html mining-app/app.js
mining-app/style.css wallet-ui/nir-coin-icon.png nir/__init__.py
nir/iris_rehearsal.py nir/application_adapter.py nir/evaluator.py nir/runner.py
nir/model.py nir/model_content.py examples/iris_model_adapter.py examples/iris.data
nir/open_model_local_run.py nir/open_model_fetch.py nir/open_model_package.py
nir/open_model_snapshot.py nir/open_model_source.py
`.trim().split(/\s+/));
const BUILD_FILES = Object.freeze(["macos/mining-Info.plist", "macos/mining-launcher.m",
  "macos/mining-runner.c", "macos/runtime-verifier.m", "blockchain/local-runtime-binding.mjs"]);

function checkedSource(relative) {
  if (typeof relative !== "string" || relative.startsWith("/") ||
      normalize(relative) !== relative || relative.split("/").includes("..")) {
    throw new Error("model app source path is unsafe");
  }
  let path = ROOT;
  for (const part of relative.split("/")) {
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink()) throw new Error("model app source contains a symlink");
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) {
    throw new Error("model app source is not a bounded regular file");
  }
  return path;
}

function command(program, args, label, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr?.trim() ?? "unknown error"}`);
  return result.stdout.trim();
}

function pythonExecutable() {
  const requested = process.env.NIR_MINING_PYTHON || "python3";
  const located = requested.startsWith("/") ? requested : command("/usr/bin/which", [requested], "Python lookup");
  // Preserve a venv's executable symlink: resolving it to the base interpreter
  // discards pyvenv.cfg/site-packages and can silently disable pinned MLX deps.
  if (!located.startsWith("/")) throw new Error("Python executable must have an absolute path");
  const path = located;
  const version = command(path, ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"], "Python version");
  const [major, minor] = version.split(".").map(Number);
  if (major !== 3 || minor < 11) throw new Error("Python 3.11 or newer is required");
  const status = command(path, ["-m", "nir.iris_rehearsal", "--check"], "Iris preflight", { cwd: ROOT });
  if (JSON.parse(status).status !== "pinned-iris-ready") throw new Error("Iris preflight is not ready");
  return path;
}

function nodeExecutable() {
  const requested = process.env.NIR_MINING_NODE || process.execPath;
  if (!requested.startsWith("/")) throw new Error("Node.js executable must have an absolute path");
  const version = command(requested, ["--version"], "Node.js version");
  if (!/^v(?:2[6-9]|[3-9][0-9])\./.test(version)) throw new Error("Node.js 26 or newer is required");
  return requested;
}

function runtimeBinding(node, python) {
  const info = JSON.parse(command(python, ["-I", "-c",
    "import json,sys; print(json.dumps({'prefix':sys.prefix,'basePrefix':sys.base_prefix}))"],
  "Python runtime identity"));
  return createRuntimeBinding({ nodePath: node, pythonPath: python,
    pythonPrefix: info.prefix, pythonBasePrefix: info.basePrefix });
}

function icon(resources) {
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
  command("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(resources, "NIR.icns")], "icon compilation");
  rmSync(iconset, { recursive: true });
}

export function buildMacMiningApp(targetPath, { sign = true } = {}) {
  if (process.platform !== "darwin") throw new Error("local model app build requires macOS");
  if (Number(process.versions.node.split(".")[0]) < 26) throw new Error("Node.js 26 or newer is required");
  if (typeof targetPath !== "string" || !targetPath.startsWith("/")) {
    throw new Error("model app destination must be an absolute path");
  }
  const target = resolve(targetPath);
  if (basename(target) !== "NIR Model Lab.app") throw new Error("destination must be NIR Model Lab.app");
  const parent = dirname(target);
  if (!lstatSync(parent).isDirectory()) throw new Error("destination parent is not a directory");
  try { lstatSync(target); throw new Error("destination must be a new NIR Model Lab.app path"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const relative of [...FILES, ...BUILD_FILES]) checkedSource(relative);
  const python = pythonExecutable();
  const node = nodeExecutable();
  const scratch = mkdtempSync(join(parent, ".nir-model-build-"));
  try {
    const app = join(scratch, "NIR Model Lab.app");
    const contents = join(app, "Contents");
    const resources = join(contents, "Resources");
    const payload = join(resources, "app");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(payload, { recursive: true });
    const version = JSON.parse(readFileSync(checkedSource("package.json"), "utf8")).version;
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version ?? "")) throw new Error("invalid model app version");
    const info = readFileSync(checkedSource("macos/mining-Info.plist"), "utf8")
      .replace(/(<key>CFBundleShortVersionString<\/key><string>)[^<]+(<\/string>)/,
        (_, before, after) => `${before}${version}${after}`)
      .replace(/(<key>CFBundleVersion<\/key><string>)[^<]+(<\/string>)/,
        (_, before, after) => `${before}${version}${after}`);
    writeFileSync(join(contents, "Info.plist"), info);
    writeFileSync(join(resources, "NIR-RUNTIME.json"), `${JSON.stringify(runtimeBinding(node, python))}\n`);
    writeFileSync(join(resources, "NIR-LOCAL-BUILD.json"),
      '{"format":"nir-local-model-build-v1","distribution":"not-a-public-installer","rewardEligible":false}\n');
    icon(resources);
    command("/usr/bin/clang", ["-fobjc-arc", "-framework", "AppKit", "-framework",
      "Foundation", "-framework", "Security", "-framework", "WebKit",
      checkedSource("macos/mining-launcher.m"),
      "-o", join(contents, "MacOS", "launcher")], "native model app build");
    command("/usr/bin/clang", [checkedSource("macos/mining-runner.c"), "-o",
      join(contents, "MacOS", "mining-runner")], "native process-group runner build");
    command("/usr/bin/clang", ["-fobjc-arc", "-framework", "Foundation",
      checkedSource("macos/runtime-verifier.m"), "-o",
      join(contents, "MacOS", "runtime-verifier")], "native runtime verifier build");
    for (const relative of FILES) {
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
    if (process.argv.length !== 3) throw new Error("usage: mine:macos-build /absolute/path/NIR Model Lab.app");
    process.stdout.write(`${buildMacMiningApp(process.argv[2])}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
