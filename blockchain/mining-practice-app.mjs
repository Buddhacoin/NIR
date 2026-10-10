import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createOpenModelCatalog } from "./open-model-catalog.mjs";
import { PROVIDERS, createCapabilityDeclaration } from "./model-provider-capabilities.mjs";
import { evaluateIrisLinearCandidate, evaluateIrisPostCommitStress,
  hashIrisModelCommit, MAX_IRIS_MODEL_BYTES,
  recheckIrisPostCommitRecord } from "./iris-linear-candidate.mjs";
import { verifyOperatorWalletProof } from "./operator-wallet-link.mjs";

const execFileAsync = promisify(execFile);
const MAX_IRIS_EVIDENCE_BYTES = 1_000_000;
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/nir-icon.png", ["../wallet-ui/nir-coin-icon.png", "image/png"]],
  ["/iris-linear-sample.json", ["../examples/iris_integer_linear.json", "application/json; charset=utf-8"]],
]);
const APP_FILES = Object.freeze([
  "mining-app/index.html", "mining-app/app.js", "mining-app/style.css",
  "wallet-ui/nir-coin-icon.png", "nir/iris_rehearsal.py",
  "examples/iris_model_adapter.py", "examples/iris.data",
  "examples/iris_integer_linear.json", "blockchain/iris-linear-candidate.mjs",
  "blockchain/operator-wallet-link.mjs", "blockchain/crypto.mjs",
  "blockchain/consensus-codec.mjs", "blockchain/constants.mjs",
  "blockchain/model-provider-capabilities.mjs",
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

export async function runPinnedModel(root, { includeEvidence = false } = {}) {
  const { stdout } = await execFileAsync(process.env.NIR_MINING_PYTHON ?? "python3", [
    "-B", "-m", "nir.iris_rehearsal", ...(includeEvidence ? ["--export-evidence"] : []),
  ], {
    cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8",
    timeout: 30_000, maxBuffer: includeEvidence ? MAX_IRIS_EVIDENCE_BYTES + 1024 : 16_384,
  });
  const parsed = JSON.parse(stdout);
  if (!includeEvidence) return publicModelResult(parsed);
  const result = publicModelResult(parsed?.summary);
  if (!validIrisEvidence(parsed, result)) throw new Error("invalid local Iris evidence");
  return { ...result, evidence: parsed };
}

export async function verifyPinnedIrisEvidence(root, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_IRIS_EVIDENCE_BYTES)
    throw new Error("invalid local Iris evidence size");
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.env.NIR_MINING_PYTHON ?? "python3", [
      "-B", "-m", "nir.iris_rehearsal", "--verify-evidence",
    ], { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin",
      PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["pipe", "pipe", "ignore"] });
    const chunks = [];
    let length = 0;
    const deadline = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > 4096) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(deadline);
      if (code !== 0 || length > 4096) reject(new Error("local Iris evidence failed replay"));
      else resolve(Buffer.concat(chunks, length).toString("utf8"));
    });
    child.stdin.end(bytes);
  });
  const parsed = JSON.parse(result);
  if (parsed?.status !== "local-iris-evidence-matched" ||
      !/^[0-9a-f]{64}$/.test(parsed.bundleHash) ||
      parsed.independentlyVerified !== false || parsed.networkSubmitted !== false ||
      parsed.rewardEligible !== false || Object.keys(parsed).sort().join(",") !==
      "bundleHash,independentlyVerified,networkSubmitted,rewardEligible,status")
    throw new Error("invalid local Iris replay result");
  return parsed;
}

function validIrisEvidence(evidence, result) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
      Object.keys(evidence).sort().join(",") !== "bundle,format,summary" ||
      evidence.format !== "nir-local-iris-evidence-v1" ||
      !evidence.bundle || typeof evidence.bundle !== "object" || Array.isArray(evidence.bundle) ||
      evidence.bundle.bundle_hash !== result.bundleHash) return false;
  try {
    return canonicalJson(evidence.summary) === canonicalJson(result) &&
      Buffer.byteLength(JSON.stringify(evidence)) <= MAX_IRIS_EVIDENCE_BYTES;
  } catch { return false; }
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
  const { stdout } = await execFileAsync(process.env.NIR_MINING_PYTHON ?? "python3", [
    "-B", "-m", "nir.open_model_local_run", "--prompt", QWEN_PROMPT,
    "--allow-1.5gb-download",
  ], {
    cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8",
    timeout: 30 * 60_000, maxBuffer: 16_384,
  });
  return publicOpenModelResult(JSON.parse(stdout));
}

export async function replayPinnedQwen(root, recordBytes) {
  const directory = mkdtempSync(join(tmpdir(), "nir-local-replay-"));
  try {
    const path = join(directory, "record.json");
    writeFileSync(path, recordBytes, { flag: "wx", mode: 0o600 });
    const { stdout } = await execFileAsync(process.env.NIR_MINING_PYTHON ?? "python3", [
      "-B", "-m", "nir.open_model_local_run", "--replay-record", path,
      "--allow-1.5gb-download",
    ], {
      cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8",
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
  const { stdout } = await execFileAsync(process.env.NIR_MINING_PYTHON ?? "python3", [
    "-B", "-m", "nir.open_model_local_run", "--check-runtime",
  ], {
    cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8",
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
  runReplay = replayPinnedQwen, verifyIris = verifyPinnedIrisEvidence,
  catalog = createOpenModelCatalog() } = {}) {
  if (!root) throw new Error("repository root is required");
  let running = false;
  let lastIrisEvidence = null;
  let pendingCandidate = null;
  let pendingWalletChallenge = null;
  let linkedWalletAddress = null;
  const sessionToken = randomBytes(32);
  function authorized(request) {
    const supplied = request.headers["x-nir-session"];
    return typeof supplied === "string" && /^[0-9a-f]{64}$/.test(supplied) &&
      timingSafeEqual(Buffer.from(supplied, "hex"), sessionToken);
  }
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
    if (request.method === "POST" && path === "/wallet-link/challenge" &&
        request.url === path) {
      if (!authorized(request) || request.headers.origin !== origin ||
          request.headers["content-length"] !== "0" || request.headers["transfer-encoding"]) {
        send(403, "application/json; charset=utf-8", JSON.stringify({ error: "Request refused" }));
        return;
      }
      pendingWalletChallenge = { value: randomBytes(32).toString("hex"),
        expiresAt: Date.now() + 300_000 };
      linkedWalletAddress = null;
      send(200, "application/json; charset=utf-8", JSON.stringify({
        challenge: pendingWalletChallenge.value, expiresAt: pendingWalletChallenge.expiresAt,
        scope: "local-address-ownership-only", networkSubmitted: false, rewardEligible: false,
      }));
      return;
    }
    if (request.method === "POST" && path === "/wallet-link/complete" &&
        request.url === path) {
      const declared = Number(request.headers["content-length"]);
      if (!authorized(request) || request.headers.origin !== origin ||
          request.headers["content-type"] !== "application/json" ||
          request.headers["transfer-encoding"] || !Number.isSafeInteger(declared) ||
          declared < 1 || declared > 16_384) {
        send(403, "application/json; charset=utf-8", JSON.stringify({ error: "Request refused" }));
        return;
      }
      const challenge = pendingWalletChallenge;
      pendingWalletChallenge = null;
      if (!challenge || challenge.expiresAt <= Date.now()) {
        send(410, "application/json; charset=utf-8", JSON.stringify({ error: "Challenge expired" }));
        return;
      }
      const deadline = setTimeout(() => request.destroy(), 10_000);
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > declared) throw new Error("invalid size");
          chunks.push(chunk);
        }
        if (length !== declared) throw new Error("truncated proof");
        const proof = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
        linkedWalletAddress = verifyOperatorWalletProof(proof, {
          challenge: challenge.value, now: Date.now(),
        });
        send(200, "application/json; charset=utf-8", JSON.stringify({
          status: "local-address-ownership-verified", address: linkedWalletAddress,
          networkSubmitted: false, rewardEligible: false, walletChanged: false,
        }));
      } catch {
        send(400, "application/json; charset=utf-8", JSON.stringify({ error: "Invalid wallet-link proof" }));
      } finally { clearTimeout(deadline); }
      return;
    }
    if (request.method === "GET" && path === "/catalog" && request.url === "/catalog") {
      send(200, "application/json; charset=utf-8", JSON.stringify(await catalog.get()));
      return;
    }
    if (request.method === "GET" && path === "/provider-capabilities" &&
        request.url === "/provider-capabilities") {
      send(200, "application/json; charset=utf-8", JSON.stringify({
        scope: "onboarding-only", providers: PROVIDERS,
      }));
      return;
    }
    if (request.method === "POST" && path === "/provider-capabilities/declaration" &&
        request.url === "/provider-capabilities/declaration") {
      const declared = Number(request.headers["content-length"]);
      if (!authorized(request) || request.headers.origin !== origin ||
          request.headers["content-type"] !== "application/json" ||
          request.headers["transfer-encoding"] || !Number.isSafeInteger(declared) ||
          declared < 2 || declared > 256) {
        send(403, "application/json; charset=utf-8", JSON.stringify({ error: "Request refused" }));
        return;
      }
      const deadline = setTimeout(() => request.destroy(), 5000);
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > declared) throw new Error("Oversized declaration");
          chunks.push(chunk);
        }
        if (length !== declared) throw new Error("Truncated declaration");
        const result = createCapabilityDeclaration(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        send(200, "application/json; charset=utf-8", JSON.stringify(result));
      } catch {
        if (!response.destroyed)
          send(400, "application/json; charset=utf-8", JSON.stringify({ error: "Invalid capability intent" }));
      } finally { clearTimeout(deadline); }
      return;
    }
    if (request.method === "GET" && path === "/model-evidence" &&
        request.url === "/model-evidence") {
      if (!authorized(request) || (request.headers.origin && request.headers.origin !== origin)) {
        send(403, "application/json; charset=utf-8", JSON.stringify({ error: "Request refused" }));
      } else if (!lastIrisEvidence) {
        send(404, "application/json; charset=utf-8", JSON.stringify({ error: "Evidence unavailable" }));
      } else {
        send(200, "application/json; charset=utf-8", lastIrisEvidence);
      }
      return;
    }
    if (request.method === "POST" && path === "/candidate/iris-linear/recheck" &&
        request.url === "/candidate/iris-linear/recheck") {
      const declared = Number(request.headers["content-length"]);
      if (!authorized(request) || request.headers.origin !== origin ||
          request.headers["content-type"] !== "application/json" ||
          request.headers["transfer-encoding"] || !Number.isSafeInteger(declared) ||
          declared < 1 || declared > 16_384) {
        send(403, "application/json; charset=utf-8", JSON.stringify({ error: "Request refused" }));
        return;
      }
      if (running) {
        send(409, "application/json; charset=utf-8", JSON.stringify({ error: "A model is already running" }));
        return;
      }
      running = true;
      const deadline = setTimeout(() => request.destroy(), 10_000);
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > declared || length > 16_384) throw new Error("oversized recheck request");
          chunks.push(chunk);
        }
        if (length !== declared) throw new Error("truncated recheck request");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
        const input = JSON.parse(text);
        if (!input || Object.keys(input).sort().join(",") !== "modelBase64,record" ||
            JSON.stringify(input) !== text || typeof input.modelBase64 !== "string" ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(input.modelBase64))
          throw new Error("invalid recheck request");
        const model = Buffer.from(input.modelBase64, "base64");
        if (model.length < 1 || model.length > MAX_IRIS_MODEL_BYTES ||
            model.toString("base64") !== input.modelBase64)
          throw new Error("invalid recheck model");
        const checked = recheckIrisPostCommitRecord(root, model, input.record);
        send(200, "application/json; charset=utf-8", JSON.stringify(checked));
      } catch {
        if (!response.destroyed)
          send(400, "application/json; charset=utf-8", JSON.stringify({ error: "Invalid local recheck files" }));
      } finally { clearTimeout(deadline); running = false; }
      return;
    }
    if (request.method === "POST" && path === "/candidate/iris-linear/commit" &&
        request.url === "/candidate/iris-linear/commit") {
      const declared = Number(request.headers["content-length"]);
      if (!authorized(request) || request.headers.origin !== origin ||
          request.headers["content-type"] !== "application/json" ||
          request.headers["transfer-encoding"] || !Number.isSafeInteger(declared) ||
          declared < 1 || declared > MAX_IRIS_MODEL_BYTES) {
        send(403, "application/json; charset=utf-8", JSON.stringify({ error: "Request refused" }));
        return;
      }
      if (running || (pendingCandidate && pendingCandidate.expiresAt > Date.now())) {
        send(409, "application/json; charset=utf-8", JSON.stringify({ error: "A candidate is pending" }));
        return;
      }
      running = true;
      const deadline = setTimeout(() => request.destroy(), 10_000);
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > declared || length > MAX_IRIS_MODEL_BYTES)
            throw new Error("oversized Iris model");
          chunks.push(chunk);
        }
        if (length !== declared) throw new Error("truncated Iris model");
        clearTimeout(deadline);
        const bytes = Buffer.concat(chunks, length);
        const checked = evaluateIrisLinearCandidate(root, bytes);
        const challengeId = randomBytes(16).toString("hex");
        pendingCandidate = { bytes, challengeId, modelHash: checked.modelHash,
          commitHash: hashIrisModelCommit(bytes), seed: randomBytes(32),
          expiresAt: Date.now() + 10 * 60_000 };
        send(200, "application/json; charset=utf-8", JSON.stringify({
          status: "local-model-committed", modelHash: pendingCandidate.modelHash,
          commitHash: pendingCandidate.commitHash, challengeId, expiresInSeconds: 600,
          independentOperators: false, hiddenChallenges: false,
          networkSubmitted: false, rewardEligible: false, walletChanged: false,
        }));
      } catch {
        if (!response.destroyed)
          send(400, "application/json; charset=utf-8", JSON.stringify({ error: "Invalid data-only Iris model" }));
      } finally { clearTimeout(deadline); running = false; }
      return;
    }
    if (request.method === "POST" && path === "/candidate/iris-linear/reveal" &&
        request.url === "/candidate/iris-linear/reveal") {
      const challengeId = request.headers["x-nir-challenge"];
      if (!authorized(request) || request.headers.origin !== origin ||
          request.headers["content-length"] !== "0" || request.headers["transfer-encoding"] ||
          typeof challengeId !== "string" || !/^[a-f0-9]{32}$/.test(challengeId)) {
        send(403, "application/json; charset=utf-8", JSON.stringify({ error: "Request refused" }));
        return;
      }
      if (running) {
        send(409, "application/json; charset=utf-8", JSON.stringify({ error: "A model is already running" }));
        return;
      }
      if (!pendingCandidate || pendingCandidate.challengeId !== challengeId) {
        send(404, "application/json; charset=utf-8", JSON.stringify({ error: "Challenge unavailable" }));
        return;
      }
      const challenge = pendingCandidate;
      pendingCandidate = null;
      if (challenge.expiresAt <= Date.now()) {
        send(410, "application/json; charset=utf-8", JSON.stringify({ error: "Challenge expired" }));
        return;
      }
      running = true;
      try {
        const result = evaluateIrisPostCommitStress(root, challenge.bytes, challenge.seed);
        if (result.modelHash !== challenge.modelHash || result.commitHash !== challenge.commitHash)
          throw new Error("local model commitment changed");
        send(200, "application/json; charset=utf-8", JSON.stringify(result));
      } catch {
        send(500, "application/json; charset=utf-8", JSON.stringify({ error: "Local stress check failed" }));
      } finally { running = false; }
      return;
    }
    if (request.method === "POST" && path === "/candidate/iris-linear" &&
        request.url === "/candidate/iris-linear") {
      const declared = Number(request.headers["content-length"]);
      if (!authorized(request) || request.headers.origin !== origin ||
          request.headers["content-type"] !== "application/json" ||
          request.headers["transfer-encoding"] || !Number.isSafeInteger(declared) ||
          declared < 1 || declared > MAX_IRIS_MODEL_BYTES) {
        send(403, "application/json; charset=utf-8", JSON.stringify({ error: "Request refused" }));
        return;
      }
      if (running) {
        send(409, "application/json; charset=utf-8", JSON.stringify({ error: "A model is already running" }));
        return;
      }
      running = true;
      const deadline = setTimeout(() => request.destroy(), 10_000);
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > declared || length > MAX_IRIS_MODEL_BYTES)
            throw new Error("oversized Iris model");
          chunks.push(chunk);
        }
        if (length !== declared) throw new Error("truncated Iris model");
        clearTimeout(deadline);
        const result = evaluateIrisLinearCandidate(root, Buffer.concat(chunks, length));
        send(200, "application/json; charset=utf-8", JSON.stringify(result));
      } catch {
        if (!response.destroyed)
          send(400, "application/json; charset=utf-8", JSON.stringify({ error: "Invalid data-only Iris model" }));
      } finally { clearTimeout(deadline); running = false; }
      return;
    }
    if (request.method === "POST" && path === "/model-evidence/verify" &&
        request.url === "/model-evidence/verify") {
      const declared = Number(request.headers["content-length"]);
      if (!authorized(request) || request.headers.origin !== origin ||
          request.headers["content-type"] !== "application/json" ||
          request.headers["transfer-encoding"] || !Number.isSafeInteger(declared) ||
          declared < 1 || declared > MAX_IRIS_EVIDENCE_BYTES) {
        send(403, "application/json; charset=utf-8", JSON.stringify({ error: "Request refused" }));
        return;
      }
      if (running) {
        send(409, "application/json; charset=utf-8", JSON.stringify({ error: "A model is already running" }));
        return;
      }
      running = true;
      const deadline = setTimeout(() => request.destroy(), 10_000);
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > declared || length > MAX_IRIS_EVIDENCE_BYTES)
            throw new Error("oversized local Iris evidence");
          chunks.push(chunk);
        }
        if (length !== declared) throw new Error("truncated local Iris evidence");
        clearTimeout(deadline);
        const checked = await verifyIris(root, Buffer.concat(chunks, length));
        if (checked?.status !== "local-iris-evidence-matched" ||
            !/^[0-9a-f]{64}$/.test(checked.bundleHash) ||
            checked.independentlyVerified !== false || checked.networkSubmitted !== false ||
            checked.rewardEligible !== false || Object.keys(checked).sort().join(",") !==
            "bundleHash,independentlyVerified,networkSubmitted,rewardEligible,status")
          throw new Error("invalid local Iris replay result");
        send(200, "application/json; charset=utf-8", JSON.stringify(checked));
      } catch {
        if (!response.destroyed)
          send(400, "application/json; charset=utf-8", JSON.stringify({ error: "Invalid local Iris evidence" }));
      } finally { clearTimeout(deadline); running = false; }
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
      if (!authorized(request) || request.headers.origin !== origin || request.headers["content-length"] !== "0" ||
          request.headers["transfer-encoding"]) {
        send(403, "application/json; charset=utf-8", JSON.stringify({ error: "Request refused" }));
        return;
      }
      send(200, "application/json; charset=utf-8", JSON.stringify(await catalog.refresh()));
      return;
    }
    if (request.method === "POST" && path === "/model-check") {
      if (!authorized(request) || request.headers.origin !== origin ||
          request.headers["content-length"] !== "0" || request.headers["transfer-encoding"]) {
        send(403, "application/json; charset=utf-8", JSON.stringify({ error: "Request refused" }));
        return;
      }
      if (running) {
        send(409, "application/json; charset=utf-8", JSON.stringify({ error: "Training is already running" }));
        return;
      }
      running = true;
      lastIrisEvidence = null;
      try {
        const raw = await runModel(root, { includeEvidence: true });
        const result = publicModelResult(raw);
        if (raw.evidence !== undefined) {
          if (!validIrisEvidence(raw.evidence, result)) throw new Error("invalid local Iris evidence");
          lastIrisEvidence = JSON.stringify(raw.evidence);
        }
        send(200, "application/json; charset=utf-8", JSON.stringify({
          ...result, evidenceAvailable: lastIrisEvidence !== null,
        }));
      } catch {
        send(500, "application/json; charset=utf-8", JSON.stringify({
          error: "Проверка модели не завершилась. Заявка не отправлена, награда не начислена.",
        }));
      } finally { running = false; }
      return;
    }
    if (request.method === "POST" && path === "/open-model/qwen-check" &&
        request.url === "/open-model/qwen-check") {
      if (!authorized(request) || request.headers.origin !== origin || request.headers["content-length"] !== "0" ||
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
      if (!authorized(request) || request.headers.origin !== origin ||
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
  Object.defineProperty(server, "localSessionToken", { value: sessionToken.toString("hex") });
  return server;
}
