import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createOpenModelCatalog } from "./open-model-catalog.mjs";

const execFileAsync = promisify(execFile);
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/nir-icon.png", ["../wallet-ui/nir-coin-icon.png", "image/png"]],
]);
const APP_FILES = Object.freeze([
  "mining-app/index.html", "mining-app/app.js", "mining-app/style.css",
  "wallet-ui/nir-coin-icon.png", "nir/iris_rehearsal.py",
  "examples/iris_model_adapter.py", "examples/iris.data",
  "nir/open_model_local_run.py", "nir/open_model_fetch.py",
  "nir/open_model_package.py", "nir/open_model_snapshot.py",
  "nir/open_model_source.py",
]);

export function miningModelAppPreflight({ root, platform = process.platform, nodeVersion = process.versions.node } = {}) {
  if (!root) throw new Error("repository root is required");
  let packageValid = false;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    packageValid = pkg.name === "nir-protocol" && pkg.private === true;
  } catch {}
  const major = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  const missing = APP_FILES.filter((name) => {
    try { return !lstatSync(join(root, name)).isFile(); } catch { return true; }
  });
  return {
    ready: platform === "darwin" && Number.isInteger(major) && major >= 26 &&
      packageValid && missing.length === 0,
    checks: [
      [platform === "darwin", "Для этого локального приложения нужен macOS."],
      [Number.isInteger(major) && major >= 26, "Для приложения нужен Node.js 26+."],
      [packageValid, "Запустите команду из корня доверенной копии исходного кода NIR."],
      [missing.length === 0, `Отсутствуют файлы локальной модели или интерфейса: ${missing.join(", ")}.`],
    ],
  };
}

function validModelResult(result) {
  return result?.status === "pinned-local-model-evaluation" &&
    result.scope === "local-public-iris-example-only" &&
    result.caseCount === 30 &&
    Number.isSafeInteger(result.baselineAccuracyBps) &&
    Number.isSafeInteger(result.candidateAccuracyBps) &&
    result.baselineAccuracyBps >= 0 && result.baselineAccuracyBps <= 10_000 &&
    result.candidateAccuracyBps >= 0 && result.candidateAccuracyBps <= 10_000 &&
    /^[0-9a-f]{64}$/.test(result.bundleHash) && result.bundleVerified === true &&
    result.independentOperators === false && result.hiddenChallenges === false &&
    result.energyAttested === false && result.networkSubmitted === false &&
    result.rewardCredited === false && result.walletChanged === false;
}

function publicModelResult(result) {
  if (!validModelResult(result)) throw new Error("invalid pinned model evaluation result");
  return {
    status: "pinned-local-model-evaluation", scope: "local-public-iris-example-only",
    baselineAccuracyBps: result.baselineAccuracyBps,
    candidateAccuracyBps: result.candidateAccuracyBps,
    caseCount: 30, bundleHash: result.bundleHash, bundleVerified: true,
    independentOperators: false, hiddenChallenges: false, energyAttested: false,
    networkSubmitted: false, rewardCredited: false, walletChanged: false,
  };
}

export async function runPinnedModel(root) {
  const { stdout } = await execFileAsync("python3", ["-m", "nir.iris_rehearsal"], {
    cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, encoding: "utf8",
    timeout: 30_000, maxBuffer: 16_384,
  });
  const result = JSON.parse(stdout);
  return publicModelResult(result);
}

const QWEN_REPOSITORY = "Qwen/Qwen3-0.6B";
const QWEN_REVISION = "c1899de289a04d12100db370d81485cdf75e47ca";
const QWEN_PROMPT = "Reply with the single word NIR.";
const REPLAY_DOMAIN = "NIR_LOCAL_OPEN_MODEL_REPLAY_V1\0";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function localReplayRecordHash(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("local replay record is invalid");
  }
  const { recordHash, ...payload } = record;
  if (recordHash === undefined) throw new Error("local replay record has no hash");
  return `sha256:${createHash("sha256").update(REPLAY_DOMAIN, "utf8")
    .update(canonicalJson(payload), "utf8").digest("hex")}`;
}

function publicOpenModelResult(result) {
  const record = result?.record;
  if (result?.repository !== QWEN_REPOSITORY || result.revision !== QWEN_REVISION ||
      !/^sha256:[0-9a-f]{64}$/.test(result.packageIdentity) ||
      typeof result.answer !== "string" || result.answer.length > 4096 ||
      result.rewardEligible !== false || result.networkSubmitted !== false ||
      result.independentlyVerified !== false ||
      !record || typeof record !== "object" || Array.isArray(record) ||
      Object.keys(record).sort().join(",") !== ["answer", "format", "generation", "independentlyVerified",
        "networkSubmitted", "packageIdentity", "prompt", "recordHash", "repository", "revision",
        "rewardEligible", "runtimeDeclaration", "scope"].sort().join(",") ||
      record.format !== "nir-local-open-model-replay-v1" ||
      record.scope !== "non-reward-local-replay" ||
      record.repository !== QWEN_REPOSITORY || record.revision !== QWEN_REVISION ||
      record.packageIdentity !== result.packageIdentity || record.answer !== result.answer ||
      record.prompt !== QWEN_PROMPT || !/^sha256:[0-9a-f]{64}$/.test(record.recordHash) ||
      record.recordHash !== localReplayRecordHash(record) ||
      record.rewardEligible !== false || record.networkSubmitted !== false ||
      record.independentlyVerified !== false ||
      JSON.stringify(record.generation) !== JSON.stringify({ temperature: "0", maxTokens: 32 }) ||
      JSON.stringify(record.runtimeDeclaration) !== JSON.stringify({
        mlx: "0.32.3", "mlx-lm": "0.32.0", transformers: "5.17.0",
      })) {
    throw new Error("invalid pinned open-model result");
  }
  return {
    status: "local-open-model-inference-only", repository: QWEN_REPOSITORY,
    revision: QWEN_REVISION, packageIdentity: result.packageIdentity,
    answer: result.answer, record, rewardEligible: false, networkSubmitted: false,
    independentlyVerified: false,
  };
}

export async function runPinnedQwen(root) {
  const { stdout } = await execFileAsync("python3", [
    "-m", "nir.open_model_local_run", "--prompt", QWEN_PROMPT,
    "--allow-1.5gb-download",
  ], {
    cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, encoding: "utf8",
    timeout: 30 * 60_000, maxBuffer: 16_384,
  });
  return publicOpenModelResult(JSON.parse(stdout));
}

export async function replayPinnedQwen(root, recordBytes) {
  const directory = mkdtempSync(join(tmpdir(), "nir-local-replay-"));
  try {
    const path = join(directory, "record.json");
    writeFileSync(path, recordBytes, { flag: "wx", mode: 0o600 });
    const { stdout } = await execFileAsync("python3", [
      "-m", "nir.open_model_local_run", "--replay-record", path,
      "--allow-1.5gb-download",
    ], {
      cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, encoding: "utf8",
      timeout: 30 * 60_000, maxBuffer: 4_096,
    });
    return publicReplayResult(JSON.parse(stdout));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function publicReplayResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).sort().join(",") !== ["status", "recordHash", "rewardEligible",
        "networkSubmitted", "independentlyVerified"].sort().join(",") ||
      result.status !== "local-replay-matched" ||
      !/^sha256:[0-9a-f]{64}$/.test(result.recordHash) ||
      result.rewardEligible !== false || result.networkSubmitted !== false ||
      result.independentlyVerified !== false) throw new Error("invalid local replay result");
  return { status: "local-replay-matched", recordHash: result.recordHash,
    rewardEligible: false, networkSubmitted: false, independentlyVerified: false };
}

export async function checkPinnedQwenRuntime(root) {
  const { stdout } = await execFileAsync("python3", [
    "-m", "nir.open_model_local_run", "--check-runtime",
  ], {
    cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, encoding: "utf8",
    timeout: 10_000, maxBuffer: 4_096,
  });
  const result = JSON.parse(stdout);
  if (!["pinned-qwen-runtime-ready", "unsupported-machine", "python-3.13-required",
        "missing-runtime", "runtime-version-mismatch"].includes(result?.status) ||
      (result.package && !["mlx", "mlx-lm", "transformers"].includes(result.package))) {
    throw new Error("invalid local runtime status");
  }
  return result;
}

export function createMiningPracticeApp({ root, runModel = runPinnedModel,
  runOpenModel = runPinnedQwen, checkOpenModel = checkPinnedQwenRuntime,
  runReplay = replayPinnedQwen,
  catalog = createOpenModelCatalog() } = {}) {
  if (!root) throw new Error("repository root is required");
  let running = false;
  const openModelJobs = new Map();
  const server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    };
    function send(code, type, data) {
      response.writeHead(code, { ...headers, "Content-Type": type });
      response.end(data);
    }
    if (request.headers.host !== `127.0.0.1:${server.address().port}`) {
      send(403, "text/plain; charset=utf-8", "Forbidden");
      return;
    }
    let path;
    try { path = new URL(request.url, origin).pathname; }
    catch { send(400, "text/plain; charset=utf-8", "Bad request"); return; }
    if (request.method === "GET" && assets.has(path)) {
      const [name, type] = assets.get(path);
      try {
        const bytes = readFileSync(join(root, "mining-app", name));
        send(200, type, bytes);
      }
      catch { send(500, "text/plain; charset=utf-8", "App asset unavailable"); }
      return;
    }
    if (request.method === "GET" && path === "/status") {
      send(200, "application/json; charset=utf-8", JSON.stringify({ status: "local-model-service-ready" }));
      return;
    }
    if (request.method === "GET" && path === "/catalog" && request.url === "/catalog") {
      send(200, "application/json; charset=utf-8", JSON.stringify(await catalog.get()));
      return;
    }
    if (request.method === "GET" && path === "/open-model/runtime" &&
        request.url === "/open-model/runtime") {
      try {
        send(200, "application/json; charset=utf-8", JSON.stringify(await checkOpenModel(root)));
      } catch {
        send(503, "application/json; charset=utf-8", JSON.stringify({ status: "runtime-check-unavailable" }));
      }
      return;
    }
    if (request.method === "GET" && /^\/open-model\/jobs\/[a-f0-9]{32}$/.test(path) &&
        request.url === path && (!request.headers.origin || request.headers.origin === origin)) {
      const job = openModelJobs.get(path.slice("/open-model/jobs/".length));
      if (!job) { send(404, "application/json; charset=utf-8", JSON.stringify({ error: "Job unavailable" })); return; }
      if (job.status === "running") {
        send(202, "application/json; charset=utf-8", JSON.stringify({ status: "running" }));
      } else if (job.status === "failed") {
        send(500, "application/json; charset=utf-8", JSON.stringify({
          error: "Локальная модель не запустилась. Заявка не отправлена, награда не начислена.",
        }));
      } else {
        send(200, "application/json; charset=utf-8", JSON.stringify(job.result));
      }
      return;
    }
    if (request.method === "POST" && path === "/catalog/refresh" && request.url === "/catalog/refresh") {
      if (request.headers.origin !== origin || request.headers["content-length"] !== "0" ||
          request.headers["transfer-encoding"]) {
        send(403, "application/json; charset=utf-8", JSON.stringify({ error: "Request refused" }));
        return;
      }
      send(200, "application/json; charset=utf-8", JSON.stringify(await catalog.refresh()));
      return;
    }
    if (request.method === "POST" && path === "/model-check") {
      if (request.headers.origin !== origin ||
          request.headers["content-length"] !== "0" || request.headers["transfer-encoding"]) {
        send(403, "application/json; charset=utf-8", JSON.stringify({ error: "Request refused" }));
        return;
      }
      if (running) {
        send(409, "application/json; charset=utf-8", JSON.stringify({ error: "Training is already running" }));
        return;
      }
      running = true;
      try {
        const result = publicModelResult(await runModel(root));
        send(200, "application/json; charset=utf-8", JSON.stringify(result));
      } catch {
        send(500, "application/json; charset=utf-8", JSON.stringify({
          error: "Проверка модели не завершилась. Заявка не отправлена, награда не начислена.",
        }));
      } finally { running = false; }
      return;
    }
    if (request.method === "POST" && path === "/open-model/qwen-check" &&
        request.url === "/open-model/qwen-check") {
      if (request.headers.origin !== origin || request.headers["content-length"] !== "0" ||
          request.headers["transfer-encoding"] ||
          request.headers["x-nir-download-consent"] !== "qwen3-0.6b-up-to-4gib") {
        send(403, "application/json; charset=utf-8", JSON.stringify({ error: "Request refused" }));
        return;
      }
      if (running) {
        send(409, "application/json; charset=utf-8", JSON.stringify({ error: "A model is already running" }));
        return;
      }
      running = true;
      for (const [id, old] of openModelJobs) {
        if (old.status !== "running" && Date.now() - old.finishedAt > 30 * 60_000) openModelJobs.delete(id);
      }
      if (openModelJobs.size >= 4) openModelJobs.delete(openModelJobs.keys().next().value);
      const jobId = randomBytes(16).toString("hex");
      const job = { status: "running" };
      openModelJobs.set(jobId, job);
      send(202, "application/json; charset=utf-8", JSON.stringify({ status: "running", jobId }));
      void Promise.resolve().then(() => runOpenModel(root)).then((raw) => {
        job.result = publicOpenModelResult(raw);
        job.status = "done";
      }).catch(() => { job.status = "failed"; }).finally(() => {
        job.finishedAt = Date.now();
        running = false;
      });
      return;
    }
    if (request.method === "POST" && path === "/open-model/replay" &&
        request.url === "/open-model/replay") {
      const declared = Number(request.headers["content-length"]);
      if (request.headers.origin !== origin ||
          request.headers["content-type"] !== "application/json" ||
          request.headers["x-nir-download-consent"] !== "qwen3-0.6b-up-to-4gib" ||
          request.headers["transfer-encoding"] ||
          !Number.isSafeInteger(declared) || declared < 1 || declared > 16_384) {
        send(403, "application/json; charset=utf-8", JSON.stringify({ error: "Request refused" }));
        return;
      }
      if (running) {
        send(409, "application/json; charset=utf-8", JSON.stringify({ error: "A model is already running" }));
        return;
      }
      let bytes;
      const deadline = setTimeout(() => request.destroy(), 10_000);
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 16_384 || length > declared) throw new Error("oversized replay body");
          chunks.push(chunk);
        }
        if (length !== declared) throw new Error("truncated replay body");
        bytes = Buffer.concat(chunks, length);
        const record = JSON.parse(bytes.toString("utf8"));
        publicOpenModelResult({ repository: QWEN_REPOSITORY, revision: QWEN_REVISION,
          packageIdentity: record?.packageIdentity, answer: record?.answer, record,
          rewardEligible: false, networkSubmitted: false, independentlyVerified: false });
      } catch {
        send(400, "application/json; charset=utf-8", JSON.stringify({ error: "Invalid replay record" }));
        return;
      } finally { clearTimeout(deadline); }
      running = true;
      for (const [id, old] of openModelJobs) {
        if (old.status !== "running" && Date.now() - old.finishedAt > 30 * 60_000) openModelJobs.delete(id);
      }
      if (openModelJobs.size >= 4) openModelJobs.delete(openModelJobs.keys().next().value);
      const jobId = randomBytes(16).toString("hex");
      const job = { status: "running" };
      openModelJobs.set(jobId, job);
      send(202, "application/json; charset=utf-8", JSON.stringify({ status: "running", jobId }));
      void Promise.resolve().then(() => runReplay(root, bytes)).then((result) => {
        const publicResult = publicReplayResult(result);
        if (publicResult.recordHash !== JSON.parse(bytes.toString("utf8")).recordHash)
          throw new Error("invalid replay result");
        job.result = publicResult;
        job.status = "done";
      }).catch(() => { job.status = "failed"; }).finally(() => {
        job.finishedAt = Date.now();
        running = false;
      });
      return;
    }
    send(404, "text/plain; charset=utf-8", "Not found");
  });
  return server;
}
