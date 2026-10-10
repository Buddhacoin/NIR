import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { buildMacMiningApp } from "../blockchain/mining-macos-build.mjs";

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
});

test("double-click model app build includes only local UI and model code, without overwriting", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync(join(tmpdir(), "nir-model-build-test-"));
  try {
    const app = join(directory, "NIR Model Lab.app");
    assert.equal(buildMacMiningApp(app, { sign: false }), app);
    for (const relative of ["Contents/Info.plist", "Contents/MacOS/launcher",
      "Contents/MacOS/mining-runner",
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
    assert.equal(runtime.nodeExecutable, process.execPath);
    assert.match(runtime.pythonExecutable, /^\//);
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
    assert.equal(runtime.pythonExecutable, python);
    const prefix = spawnSync(runtime.pythonExecutable, ["-c", "import sys; print(sys.prefix)"], { encoding: "utf8" });
    assert.equal(prefix.status, 0, prefix.stderr);
    assert.equal(realpathSync(prefix.stdout.trim()), realpathSync(venv));
  } finally {
    if (previous === undefined) delete process.env.NIR_MINING_PYTHON;
    else process.env.NIR_MINING_PYTHON = previous;
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
    child = spawn(runtime.nodeExecutable, [join(root, "blockchain/mining-practice-app-cli.mjs"), "--embedded"], {
      cwd: root, env: { ...process.env, NIR_MINING_PYTHON: runtime.pythonExecutable },
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
