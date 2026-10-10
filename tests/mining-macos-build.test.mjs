import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { buildMacMiningApp } from "../blockchain/mining-macos-build.mjs";
import { executableBinding } from "../blockchain/local-runtime-binding.mjs";

test("model app build has a bounded source allowlist and explicit nonreward marker", () => {
  const source = readFileSync(new URL("../blockchain/mining-macos-build.mjs", import.meta.url), "utf8");
  assert.match(source, /const FILES = Object\.freeze/);
  assert.doesNotMatch(source, /cpSync\(|readdirSync\(/);
  assert.match(source, /checkedSource\(relative\)/);
  assert.match(source, /rewardEligible":false/);
  assert.throws(() => buildMacMiningApp("/tmp/not-an-app"),
    process.platform === "darwin" ? /NIR Model Lab\.app/ : /requires macOS/);
  const native = readFileSync(new URL("../macos/mining-launcher.m", import.meta.url), "utf8");
  assert.match(native, /WKWebView/);
  assert.match(native, /NSMakeRect\(0, 0, 430, 800\)/);
  assert.match(native, /127\.0\.0\.1/);
  assert.match(native, /WKNavigationActionPolicyCancel/);
  assert.doesNotMatch(native, /kill\(-leader/);
  assert.match(native, /if \(self\.service\.isRunning\) \[self\.service terminate\]/);
  const runner = readFileSync(new URL("../macos/mining-runner.c", import.meta.url), "utf8");
  assert.match(runner, /setpgid\(0, 0\)/);
  assert.match(runner, /waitpid\(child/);
  assert.match(runner, /kill\(-getpgrp\(\), SIGKILL\)/);
  assert.match(native, /terminationHandler =/);
  assert.match(native, /stopServiceGroup/);
  assert.match(native, /DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM/);
  assert.match(native, /verifyRuntimeAtResources/);
  assert.ok(native.indexOf("verifyRuntimeAtResources:resources") < native.indexOf("self.service = [NSTask new]"));
});

test("double-click model app build includes only local UI and model code, without overwriting", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync(join(tmpdir(), "nir-model-build-test-"));
  try {
    const app = join(directory, "NIR Model Lab.app");
    assert.equal(buildMacMiningApp(app, { sign: false }), app);
    for (const relative of ["Contents/Info.plist", "Contents/MacOS/launcher",
      "Contents/MacOS/mining-runner",
      "Contents/MacOS/runtime-verifier",
      "Contents/Resources/NIR.icns", "Contents/Resources/NIR-RUNTIME.json",
      "Contents/Resources/NIR-LOCAL-BUILD.json",
      "Contents/Resources/app/mining-app/index.html",
      "Contents/Resources/app/mining-app/app.js",
      "Contents/Resources/app/nir/iris_rehearsal.py",
      "Contents/Resources/app/nir/open_model_local_run.py",
      "Contents/Resources/app/examples/iris.data"]) {
      assert.equal(existsSync(join(app, relative)), true, relative);
    }
    for (const relative of ["Contents/Resources/app/wallet-ui/app.js",
      "Contents/Resources/app/blockchain/wallet-files.mjs",
      "Contents/Resources/app/DEVNET-KEYS.json"]) {
      assert.equal(existsSync(join(app, relative)), false, relative);
    }
    const marker = JSON.parse(readFileSync(join(app, "Contents/Resources/NIR-LOCAL-BUILD.json")));
    assert.equal(marker.rewardEligible, false);
    assert.equal(marker.distribution, "not-a-public-installer");
    const runtime = JSON.parse(readFileSync(join(app, "Contents/Resources/NIR-RUNTIME.json")));
    assert.equal(runtime.nodeExecutable.logicalPath, process.execPath);
    assert.match(runtime.pythonExecutable.logicalPath, /^\//);
    assert.throws(() => buildMacMiningApp(app, { sign: false }), /new NIR Model Lab\.app/);
    const syntax = spawnSync("/usr/bin/clang", ["-fobjc-arc", "-fsyntax-only",
      new URL("../macos/mining-launcher.m", import.meta.url).pathname], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("selected symlinked Python venv keeps its own site-packages path", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync(join(tmpdir(), "nir-model-venv-test-"));
  const previous = process.env.NIR_MINING_PYTHON;
  try {
    const venv = join(directory, "venv");
    const created = spawnSync("python3", ["-m", "venv", venv, "--symlinks"], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const python = join(venv, "bin", "python");
    process.env.NIR_MINING_PYTHON = python;
    const app = buildMacMiningApp(join(directory, "NIR Model Lab.app"), { sign: false });
    const runtime = JSON.parse(readFileSync(join(app, "Contents/Resources/NIR-RUNTIME.json")));
    assert.equal(runtime.pythonExecutable.logicalPath,
      join(realpathSync(join(venv, "bin")), "python"));
    const prefix = spawnSync(runtime.pythonExecutable.logicalPath, ["-c", "import sys; print(sys.prefix)"], { encoding: "utf8" });
    assert.equal(prefix.status, 0, prefix.stderr);
    assert.equal(realpathSync(prefix.stdout.trim()), realpathSync(venv));
  } finally {
    if (previous === undefined) delete process.env.NIR_MINING_PYTHON;
    else process.env.NIR_MINING_PYTHON = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("signed model app pins the selected venv behind a mutable ancestor symlink", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync("/private/tmp/nir-model-ancestor-proof-test-");
  const previous = process.env.NIR_MINING_PYTHON;
  try {
    const venvA = join(directory, "venv-a");
    const venvB = join(directory, "venv-b");
    for (const venv of [venvA, venvB]) {
      const created = spawnSync("python3", ["-m", "venv", venv, "--symlinks"], { encoding: "utf8" });
      assert.equal(created.status, 0, created.stderr);
    }
    const current = join(directory, "venv-current");
    symlinkSync("venv-a", current);
    const selectedPython = join(current, "bin", "python");
    process.env.NIR_MINING_PYTHON = selectedPython;

    const bSite = spawnSync(join(venvB, "bin", "python"),
      ["-c", "import site; print(site.getsitepackages()[0])"], { encoding: "utf8" });
    assert.equal(bSite.status, 0, bSite.stderr);
    writeFileSync(join(bSite.stdout.trim(), "nir_ancestor_substitution.py"), "VALUE = 'venv-b'\n");

    const app = buildMacMiningApp(join(directory, "NIR Model Lab.app"));
    const runtime = JSON.parse(readFileSync(join(app, "Contents/Resources/NIR-RUNTIME.json")));
    const pinnedPython = runtime.pythonExecutable.logicalPath;
    assert.equal(pinnedPython, join(realpathSync(join(current, "bin")), "python"),
      "the launch path must pin the selected environment, not its mutable ancestor alias");
    assert.equal(pinnedPython.includes("venv-current"), false);
    const launcher = join(app, "Contents/MacOS/launcher");
    assert.equal(spawnSync(launcher, ["--verify-runtime"], { encoding: "utf8" }).status, 0);

    unlinkSync(current);
    symlinkSync("venv-b", current);
    assert.equal(spawnSync(selectedPython,
      ["-c", "import nir_ancestor_substitution; print(nir_ancestor_substitution.VALUE)"],
      { encoding: "utf8" }).stdout.trim(), "venv-b",
    "the original user-selected alias must demonstrate the adversarial switch to venv-b");
    const pinnedImport = spawnSync(pinnedPython,
      ["-c", "import nir_ancestor_substitution"], { encoding: "utf8" });
    assert.notEqual(pinnedImport.status, 0,
      "the manifest launch path must remain in venv-a after the ancestor alias changes");
    const pinnedPrefix = spawnSync(pinnedPython,
      ["-c", "import os,sys; print(os.path.realpath(sys.prefix))"], { encoding: "utf8" });
    assert.equal(pinnedPrefix.status, 0, pinnedPrefix.stderr);
    assert.equal(pinnedPrefix.stdout.trim(), realpathSync(venvA));
    assert.equal(spawnSync(launcher, ["--verify-runtime"], { encoding: "utf8" }).status, 0,
      "switching an unused alias must not affect the pinned and verified runtime");
  } finally {
    if (previous === undefined) delete process.env.NIR_MINING_PYTHON;
    else process.env.NIR_MINING_PYTHON = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("signed model app rejects a changed external Python runtime", () => {
  if (process.platform !== "darwin") return;
  // Keep the lexical /private/tmp prefix used by the real MLX environment.
  // Foundation's stringByStandardizingPath rewrites it to /tmp, which must not
  // alter the exact symlink-chain identity written by the JavaScript builder.
  const directory = mkdtempSync("/private/tmp/nir-model-runtime-proof-test-");
  const previous = process.env.NIR_MINING_PYTHON;
  const previousNode = process.env.NIR_MINING_NODE;
  try {
    const venv = join(directory, "venv");
    const created = spawnSync("python3", ["-m", "venv", venv, "--symlinks"], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    process.env.NIR_MINING_PYTHON = join(venv, "bin", "python");
    const nodeLink = join(directory, "node");
    const nodeTarget = `${"../".repeat(30)}${process.execPath.slice(1)}`;
    symlinkSync(nodeTarget, nodeLink);
    process.env.NIR_MINING_NODE = nodeLink;
    const app = buildMacMiningApp(join(directory, "NIR Model Lab.app"));
    const runtimePath = join(app, "Contents/Resources/NIR-RUNTIME.json");
    const originalRuntime = readFileSync(runtimePath);
    const runtime = JSON.parse(originalRuntime);
    assert.equal(runtime.format, "nir-local-runtime-binding-v1");
    assert.match(runtime.nodeExecutable.sha256, /^[0-9a-f]{64}$/);
    assert.match(runtime.pythonEnvironment.treeSha256, /^[0-9a-f]{64}$/);
    const launcher = join(app, "Contents/MacOS/launcher");
    const verify = () => spawnSync(launcher, ["--verify-runtime"], { encoding: "utf8" });
    assert.equal(verify().status, 0);

    writeFileSync(runtimePath, `${JSON.stringify({ ...runtime,
      nodeExecutable: executableBinding("/bin/echo") })}\n`);
    assert.notEqual(spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app],
      { encoding: "utf8" }).status, 0, "manifest substitution must break the app seal");
    assert.notEqual(verify().status, 0, "a substituted signed manifest must fail closed");
    writeFileSync(runtimePath, originalRuntime);
    assert.equal(verify().status, 0);

    unlinkSync(nodeLink);
    symlinkSync("/bin/echo", nodeLink);
    assert.notEqual(verify().status, 0, "Node symlink substitution must fail closed");
    assert.equal(spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app],
      { encoding: "utf8" }).status, 0, "external Node substitution must preserve the app seal");
    unlinkSync(nodeLink);
    symlinkSync(nodeTarget, nodeLink);
    assert.equal(verify().status, 0);

    const pythonLink = process.env.NIR_MINING_PYTHON;
    const pythonTarget = readlinkSync(pythonLink);
    unlinkSync(pythonLink);
    symlinkSync("/bin/echo", pythonLink);
    assert.notEqual(verify().status, 0, "Python symlink substitution must fail closed");
    unlinkSync(pythonLink);
    symlinkSync(pythonTarget, pythonLink);
    assert.equal(verify().status, 0);

    const site = spawnSync(pythonLink, ["-c", "import site; print(site.getsitepackages()[0])"],
      { encoding: "utf8" });
    assert.equal(site.status, 0, site.stderr);
    const injected = join(site.stdout.trim(), "substituted_runtime.py");
    writeFileSync(injected, "raise RuntimeError('substituted')\n");
    assert.notEqual(verify().status, 0, "new site-packages import must fail closed");
    unlinkSync(injected);
    assert.equal(verify().status, 0);

    writeFileSync(join(venv, "pyvenv.cfg"), "substituted = true\n");
    assert.equal(spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app],
      { encoding: "utf8" }).status, 0, "external mutation must not alter the app seal");
    const rejected = spawnSync(launcher, ["--verify-runtime"], { encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /runtime binding verification failed/);
  } finally {
    if (previous === undefined) delete process.env.NIR_MINING_PYTHON;
    else process.env.NIR_MINING_PYTHON = previous;
    if (previousNode === undefined) delete process.env.NIR_MINING_NODE;
    else process.env.NIR_MINING_NODE = previousNode;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runner group cleanup stops a live descendant after close and after leader crash", async () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync(join(tmpdir(), "nir-model-group-test-"));
  try {
    const app = buildMacMiningApp(join(directory, "NIR Model Lab.app"), { sign: false });
    const runner = join(app, "Contents/MacOS/mining-runner");
    for (const crash of [false, true]) {
      const marker = join(directory, crash ? "crash-marker" : "close-marker");
      const fixture = join(directory, crash ? "crash.mjs" : "close.mjs");
      const childCode = `import {appendFileSync} from 'node:fs'; setInterval(() => appendFileSync(${JSON.stringify(marker)}, '.'), 25);`;
      writeFileSync(fixture, `import {spawn} from 'node:child_process';\n` +
        `spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio:'ignore'});\n` +
        (crash ? `setTimeout(() => process.exit(0), 250);\n` : "") +
        `setInterval(() => {}, 1000);\n`);
      const leader = spawn(runner, [process.execPath, fixture, "--embedded"], { stdio: "ignore" });
      const exited = new Promise((resolve) => leader.once("exit", resolve));
      try {
        for (let i = 0; i < 100 && !existsSync(marker); i++)
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(existsSync(marker), true, "real descendant must write its marker");
        if (crash) {
          await exited;
        } else process.kill(-leader.pid, "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 100));
        const stoppedAt = readFileSync(marker).length;
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(readFileSync(marker).length, stoppedAt,
          "whole process group must stop after native cleanup signal");
      } finally {
        try { process.kill(-leader.pid, "SIGKILL"); } catch {}
        try { leader.kill("SIGKILL"); } catch {}
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("native window gives app-specific offline and Qwen runtime guidance", async () => {
  const code = readFileSync(new URL("../mining-app/app.js", import.meta.url), "utf8");
  const nodes = new Map();
  for (const id of ["start", "progress", "result", "error", "error-message", "connection",
    "language", "score", "technical", "qwen-start", "qwen-state", "qwen-answer",
    "qwen-identity"]) {
    nodes.set(`#${id}`, { hidden: true, disabled: false, dataset: {}, textContent: "",
      setAttribute() {}, addEventListener(_, listener) { this.click = listener; } });
  }
  let online = true;
  runInNewContext(code, {
    document: { documentElement: { lang: "ru" }, querySelector: (id) => nodes.get(id),
      querySelectorAll: () => [] },
    navigator: { language: "ru-RU" }, location: { search: "?local-app=1" },
    URLSearchParams, AbortController, TypeError,
    fetch: async (path) => {
      if (!online) throw new TypeError("service gone");
      if (path === "/status") return { ok: true,
        json: async () => ({ status: "local-model-service-ready" }) };
      if (path === "/open-model/runtime") return { ok: true,
        json: async () => ({ status: "python-3.13-required" }) };
      throw new Error(`unexpected request ${path}`);
    },
    setInterval: () => 0, setTimeout, clearTimeout,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(nodes.get("#qwen-state").textContent, /Mac-сборку/);
  assert.doesNotMatch(nodes.get("#qwen-state").textContent, /PATH/);
  online = false;
  await nodes.get("#start").click();
  assert.match(nodes.get("#error-message").textContent, /NIR Model Lab\.app/);
  assert.doesNotMatch(nodes.get("#error-message").textContent, /npm run mine:app|вкладку/);
});

test("packaged embedded service starts outside source checkout and runs real pinned Iris", async () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync(join(tmpdir(), "nir-model-service-test-"));
  let child;
  try {
    const app = buildMacMiningApp(join(directory, "NIR Model Lab.app"));
    const signed = () => spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app],
      { encoding: "utf8" });
    assert.equal(signed().status, 0, "the newly built bundle must have an intact seal");
    const root = join(app, "Contents/Resources/app");
    const runtime = JSON.parse(readFileSync(join(app, "Contents/Resources/NIR-RUNTIME.json")));
    child = spawn(runtime.nodeExecutable.logicalPath, [join(root, "blockchain/mining-practice-app-cli.mjs"), "--embedded"], {
      cwd: root, env: { ...process.env, NIR_MINING_PYTHON: runtime.pythonExecutable.logicalPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostic = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-1024); });
    const url = await Promise.race([
      new Promise((resolve, reject) => {
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          output += chunk;
          const match = output.match(/^NIR_MODEL_LAB_URL=(http:\/\/127\.0\.0\.1:\d+\/\?local-app=1)\nNIR_MODEL_LAB_SESSION=([0-9a-f]{64})\n/);
          if (match) resolve({ url: match[1], token: match[2] });
        });
        child.once("exit", (code) => reject(new Error(`embedded service exited ${code}`)));
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(
        `embedded service timed out after 30s: ${diagnostic}`)), 30_000)),
    ]);
    const origin = new URL(url.url).origin;
    const runtimeCheck = await fetch(`${origin}/open-model/runtime`);
    assert.equal(runtimeCheck.status, 200);
    const response = await fetch(`${origin}/model-check`, { method: "POST", headers: {
      Origin: origin, "Content-Length": "0", "X-NIR-Session": url.token,
    } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "pinned-local-model-evaluation");
    assert.equal(result.bundleVerified, true);
    assert.equal(result.rewardCredited, false);
    assert.equal(result.networkSubmitted, false);
    assert.equal(existsSync(join(root, "nir/__pycache__")), false,
      "running packaged Python must not write bytecode into the signed app");
    assert.equal(signed().status, 0, "running Iris and Qwen preflight must preserve the app seal");
  } finally {
    if (child && !child.killed) child.kill("SIGTERM");
    rmSync(directory, { recursive: true, force: true });
  }
});
