// The Update button of the source-built Mac apps (docs/app-updates.md).
//
// check(): fetch main from the app's own source checkout and read the signed
// release file; it counts only when signed by the pinned owner key and newer
// than the installed build.
// apply(): export exactly the signed commit with `git archive`, build a new
// app from it next to the installed one, then quit, swap and reopen.
//
// The user's checkout is only fetched into a private ref; its working tree
// and branches are never touched.
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import { SOURCE_RELEASE_PATH, verifySourceRelease } from "./source-release.mjs";

export const UPDATE_RECORD = "NIR-UPDATE.json";
const UPDATE_REF = "refs/nir-update/main";
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false" };

function run(file, args, { cwd, env, timeout = 120_000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolveRun, reject) => {
    execFile(file, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer, timeout },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${basename(file)} ${args[0] ?? ""} failed: ${(stderr || error.message).trim().slice(-400)}`));
        } else resolveRun(stdout.trim());
      });
  });
}

// What a build records about where it came from, for its own Update button.
// A builder writes this into the bundle before signing it.
export function buildUpdateRecord({ product, root, env = process.env, git = "git" }) {
  let sourceRoot = env.NIR_UPDATE_SOURCE_ROOT ?? null;
  let sourceRevision = env.NIR_UPDATE_SOURCE_REVISION ?? null;
  if (sourceRevision === null) {
    try {
      sourceRoot = realpathSync(root);
      if (realpathSync(execFileSync(git, ["-C", sourceRoot, "rev-parse", "--show-toplevel"],
        { encoding: "utf8" }).trim()) !== sourceRoot) throw new Error("not a checkout root");
      sourceRevision = execFileSync(git, ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      sourceRoot = null;
    }
  }
  return { builderNode: env.NIR_UPDATE_BUILDER_NODE ?? process.execPath,
    format: "nir-app-update-record-v1", product,
    releaseSequence: Number(env.NIR_UPDATE_SEQUENCE ?? 0), sourceRevision, sourceRoot };
}

export function readUpdateRecord(path) {
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (record?.format !== "nir-app-update-record-v1" || !["model-lab", "wallet"].includes(record.product) ||
      !Number.isSafeInteger(record.releaseSequence) || record.releaseSequence < 0 ||
      (record.sourceRoot !== null && !isAbsolute(record.sourceRoot ?? "")) ||
      (record.sourceRevision !== null && !REVISION.test(record.sourceRevision ?? "")) ||
      !isAbsolute(record.builderNode ?? "")) {
    throw new Error("app update record is invalid");
  }
  return record;
}

// The app's launcher is the parent of the process runner that started this
// service. Returns its pid only if it runs from inside `appPath`.
export function macLauncherPid(appPath, { ps = "/bin/ps", runnerPid = process.ppid } = {}) {
  const launcher = Number(execFileSync(ps, ["-o", "ppid=", "-p", String(runnerPid)], { encoding: "utf8" }).trim());
  const command = execFileSync(ps, ["-o", "comm=", "-p", String(launcher)], { encoding: "utf8" }).trim();
  if (!Number.isSafeInteger(launcher) || launcher <= 1 || !command.startsWith(`${appPath}/Contents/MacOS/`)) {
    throw new Error("the app launcher could not be identified");
  }
  return launcher;
}

// Waits for the launcher to exit, swaps the apps, and opens the result. The
// previous app is kept at `backup`; a failed swap reopens it.
export const SWAP_SCRIPT = `launcher="$1"; target="$2"; staged="$3"; backup="$4"; opener="$5"
i=0
while kill -0 "$launcher" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 600 ] && exit 1
  sleep 0.1
done
if mv "$target" "$backup"; then
  if mv "$staged" "$target"; then "$opener" "$target"; exit 0; fi
  mv "$backup" "$target"
fi
"$opener" "$target"
`;

export function startSwap({ launcherPid, appPath, stagedAppPath, backupPath, opener = "/usr/bin/open",
  signal = (pid) => process.kill(pid, "SIGTERM") }) {
  // A new session survives the app's process-group shutdown.
  const helper = spawn("/bin/sh", ["-c", SWAP_SCRIPT, "nir-update", String(launcherPid), appPath,
    stagedAppPath, backupPath, opener], { detached: true, stdio: "ignore" });
  helper.unref();
  signal(launcherPid);
}

export class SourceUpdater {
  #appPath;
  #record;
  #trustedAddress;
  #build;
  #restart;
  #git;
  #state = "idle";
  #release = null;
  #error = null;
  #busy = false;

  // build(sourceDirectory, stagedAppPath, release, record) makes the new app;
  // restart({ appPath, stagedAppPath, backupPath }) quits, swaps and reopens.
  constructor({ appPath, record, trustedAddress, build, restart, git = "git" }) {
    this.#appPath = appPath;
    this.#record = record;
    this.#trustedAddress = trustedAddress;
    this.#build = build;
    this.#restart = restart;
    this.#git = git;
  }

  get configured() {
    return typeof this.#trustedAddress === "string" && this.#record?.sourceRoot != null;
  }

  status() {
    return { available: this.#available(), configured: this.configured, error: this.#error,
      installed: { releaseSequence: this.#record?.releaseSequence ?? null,
        sourceRevision: this.#record?.sourceRevision ?? null },
      release: this.#release ? { sequence: this.#release.sequence, version: this.#release.version } : null,
      signer: this.#trustedAddress ?? null, state: this.#state };
  }

  #available() {
    return this.#release !== null && this.#release.sequence > this.#record.releaseSequence &&
      this.#release.sourceRevision !== this.#record.sourceRevision;
  }

  #gitIn(...args) {
    return run(this.#git, ["-C", this.#record.sourceRoot, ...args], { env: GIT_ENV });
  }

  async #fetchRelease() {
    await this.#gitIn("fetch", "--quiet", "--no-tags", "origin", `+refs/heads/main:${UPDATE_REF}`);
    let text;
    try {
      text = await this.#gitIn("show", `${UPDATE_REF}:${SOURCE_RELEASE_PATH}`);
    } catch {
      return null;
    }
    return verifySourceRelease(JSON.parse(text), { trustedAddress: this.#trustedAddress });
  }

  async check() {
    if (this.#busy) return this.status();
    if (!this.configured) {
      this.#error = this.#trustedAddress ? "no-source-checkout" : "no-release-signer";
      return this.status();
    }
    this.#busy = true;
    this.#state = "checking";
    this.#error = null;
    try {
      this.#release = await this.#fetchRelease();
      this.#state = "idle";
    } catch (error) {
      this.#state = "failed";
      this.#error = error.message;
    } finally {
      this.#busy = false;
    }
    return this.status();
  }

  // Resolves once the update has been handed to the restart step.
  async apply() {
    if (this.#busy) throw new Error("an update is already running");
    if (!this.configured) throw new Error("updates are not configured in this build");
    this.#busy = true;
    this.#error = null;
    let staging = null;
    try {
      this.#state = "checking";
      const release = await this.#fetchRelease();
      this.#release = release;
      if (!this.#available()) throw new Error("no newer signed release");
      // The signed commit must be part of main, not just any fetched object.
      await this.#gitIn("merge-base", "--is-ancestor", release.sourceRevision, UPDATE_REF);
      this.#state = "downloading";
      staging = mkdtempSync(join(dirname(this.#appPath), ".nir-update-"));
      chmodSync(staging, 0o700);
      const source = join(staging, "source");
      mkdirSync(source);
      await new Promise((resolveExtract, reject) => {
        const archive = spawn(this.#git, ["-C", this.#record.sourceRoot, "archive", "--format=tar",
          release.sourceRevision], { env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "ignore"] });
        const tar = spawn("tar", ["-x", "-f", "-", "-C", source], { stdio: ["pipe", "ignore", "ignore"] });
        archive.stdout.pipe(tar.stdin);
        let pending = 2;
        const done = (code) => {
          if (code !== 0) reject(new Error("source export failed"));
          else if (--pending === 0) resolveExtract();
        };
        archive.on("close", done);
        tar.on("close", done);
        archive.on("error", reject);
        tar.on("error", reject);
      });
      this.#state = "building";
      const stagedAppPath = join(staging, basename(this.#appPath));
      await this.#build(source, stagedAppPath, release, this.#record);
      if (!existsSync(stagedAppPath)) throw new Error("the build produced no app");
      rmSync(source, { recursive: true, force: true });
      this.#state = "restarting";
      this.#restart({ appPath: this.#appPath, backupPath: join(staging, `previous ${basename(this.#appPath)}`),
        stagedAppPath });
      staging = null;
    } catch (error) {
      this.#state = "failed";
      this.#error = error.message;
      throw error;
    } finally {
      if (staging) rmSync(staging, { recursive: true, force: true });
      this.#busy = false;
    }
    return this.status();
  }
}

// The environment a builder child process gets when an app rebuilds itself.
export function updateBuildEnvironment(release, record) {
  return { NIR_UPDATE_BUILDER_NODE: record.builderNode, NIR_UPDATE_SEQUENCE: String(release.sequence),
    NIR_UPDATE_SOURCE_REVISION: release.sourceRevision, NIR_UPDATE_SOURCE_ROOT: record.sourceRoot };
}

export function runBuilder({ node, script, target, env }) {
  return run(node, [script, target], { env, timeout: 30 * 60_000 });
}
