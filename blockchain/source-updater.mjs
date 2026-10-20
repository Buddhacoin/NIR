// The Update button of the source-built Mac apps (docs/app-updates.md).
//
// check(): fetch main of the published repository into the app's own copy
// and see whether it is newer than the installed build. When a release
// signer is pinned, only a release it signed counts.
// apply(): export exactly that commit with `git archive`, build a new app
// from it next to the installed one, then quit, swap and reopen.
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
  let sourceRevision = env.NIR_UPDATE_SOURCE_REVISION || null;
  if (sourceRevision === null) {
    try {
      const top = realpathSync(execFileSync(git, ["-C", root, "rev-parse", "--show-toplevel"],
        { encoding: "utf8" }).trim());
      if (top === realpathSync(root)) {
        sourceRevision = execFileSync(git, ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      }
    } catch {}
  }
  return { builderNode: env.NIR_UPDATE_BUILDER_NODE || process.execPath,
    format: "nir-app-update-record-v2", product,
    releaseSequence: Number(env.NIR_UPDATE_SEQUENCE || 0), sourceRevision };
}

export function readUpdateRecord(path) {
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (record?.format !== "nir-app-update-record-v2" || !["model-lab", "wallet"].includes(record.product) ||
      !Number.isSafeInteger(record.releaseSequence) || record.releaseSequence < 0 ||
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

// Where NIR's code is published. The app keeps its own copy of it, so users
// never need a checkout or git credentials.
export const SOURCE_URL = "https://github.com/Buddhacoin/NIR.git";
const SOURCE_REF = "refs/heads/main";
const WORKING = new Set(["checking", "downloading", "building", "restarting"]);

export class SourceUpdater {
  #appPath;
  #record;
  #trustedAddress;
  #sourceDirectory;
  #sourceUrl;
  #build;
  #restart;
  #git;
  #state = "idle";
  #release = null;
  #error = null;
  #busy = false;

  // sourceDirectory holds the app's own bare copy of the repository.
  // trustedAddress, once a release authority exists, makes the app accept only
  // releases it signed; until then the app follows main.
  // build(sourceDirectory, stagedAppPath, release, record) makes the new app;
  // restart({ appPath, stagedAppPath, backupPath }) quits, swaps and reopens.
  constructor({ appPath, record, sourceDirectory, sourceUrl = SOURCE_URL, trustedAddress = null, build,
    restart, git = "git" }) {
    this.#appPath = appPath;
    this.#record = record;
    this.#sourceDirectory = sourceDirectory;
    this.#sourceUrl = sourceUrl;
    this.#trustedAddress = trustedAddress;
    this.#build = build;
    this.#restart = restart;
    this.#git = git;
  }

  status() {
    return { available: this.#available(), configured: this.#record !== null,
      error: this.#record === null ? "not-updatable-build" : this.#error,
      installed: { revision: this.#record?.sourceRevision?.slice(0, 12) ?? null },
      release: this.#release && { changes: this.#release.changes, date: this.#release.date,
        revision: this.#release.sourceRevision.slice(0, 12), version: this.#release.version },
      signed: typeof this.#trustedAddress === "string", state: this.#state };
  }

  #available() {
    return this.#release !== null && this.#release.newer;
  }

  #gitIn(...args) {
    return run(this.#git, ["--git-dir", this.#sourceDirectory, ...args], { env: GIT_ENV, timeout: 600_000 });
  }

  // Fetches main into the app's own copy and describes its newest release.
  async #fetchRelease() {
    if (!existsSync(join(this.#sourceDirectory, "HEAD"))) {
      mkdirSync(dirname(this.#sourceDirectory), { recursive: true, mode: 0o700 });
      await run(this.#git, ["init", "--quiet", "--bare", this.#sourceDirectory], { env: GIT_ENV });
    }
    await this.#gitIn("fetch", "--quiet", "--no-tags", this.#sourceUrl, `+${SOURCE_REF}:${UPDATE_REF}`);
    const tip = await this.#gitIn("rev-parse", `${UPDATE_REF}^{commit}`);
    let revision = tip;
    let sequence = null;
    if (typeof this.#trustedAddress === "string") {
      let envelope;
      try {
        envelope = JSON.parse(await this.#gitIn("show", `${UPDATE_REF}:${SOURCE_RELEASE_PATH}`));
      } catch {
        return null;
      }
      const signed = verifySourceRelease(envelope, { trustedAddress: this.#trustedAddress });
      // The signed commit must be part of main, not just any fetched object.
      await this.#gitIn("merge-base", "--is-ancestor", signed.sourceRevision, UPDATE_REF);
      revision = signed.sourceRevision;
      sequence = signed.sequence;
    }
    const installed = this.#record.sourceRevision;
    const known = installed !== null &&
      await this.#gitIn("cat-file", "-e", `${installed}^{commit}`).then(() => true, () => false);
    // Newer means: not the installed commit and not one it already contains.
    let newer = revision !== installed;
    if (newer && known) {
      newer = !(await this.#gitIn("merge-base", "--is-ancestor", revision, installed).then(() => true, () => false));
    }
    if (sequence !== null) newer = newer && sequence > this.#record.releaseSequence;
    const changes = known && newer
      ? Number(await this.#gitIn("rev-list", "--count", `${installed}..${revision}`)) : null;
    const date = (await this.#gitIn("show", "-s", "--format=%cs", revision));
    let version = null;
    try {
      version = JSON.parse(await this.#gitIn("show", `${revision}:package.json`)).version ?? null;
    } catch {}
    return { changes, date, newer, sequence: sequence ?? 0, sourceRevision: revision, version };
  }

  async check() {
    if (this.#busy || this.#record === null) return this.status();
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
    if (this.#record === null) throw new Error("this build cannot update itself");
    this.#busy = true;
    this.#error = null;
    let staging = null;
    try {
      this.#state = "checking";
      const release = await this.#fetchRelease();
      this.#release = release;
      if (!this.#available()) throw new Error("no newer version");
      this.#state = "downloading";
      staging = mkdtempSync(join(dirname(this.#appPath), ".nir-update-"));
      chmodSync(staging, 0o700);
      const source = join(staging, "source");
      mkdirSync(source);
      await new Promise((resolveExtract, reject) => {
        const archive = spawn(this.#git, ["--git-dir", this.#sourceDirectory, "archive", "--format=tar",
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

  get working() {
    return WORKING.has(this.#state);
  }
}

// The environment a builder child process gets when an app rebuilds itself.
export function updateBuildEnvironment(release, record) {
  return { NIR_UPDATE_BUILDER_NODE: record.builderNode, NIR_UPDATE_SEQUENCE: String(release.sequence),
    NIR_UPDATE_SOURCE_REVISION: release.sourceRevision };
}

export function runBuilder({ node, script, target, env }) {
  return run(node, [script, target], { env, timeout: 30 * 60_000 });
}
