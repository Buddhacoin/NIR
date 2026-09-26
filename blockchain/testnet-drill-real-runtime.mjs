import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBlockStore } from "./block-store.mjs";
import { createTransfer, NirChain } from "./chain.mjs";
import { canonicalJson, publicWallet } from "./crypto.mjs";
import { DistributedCoordinator, initializeDistributedDevnet } from "./distributed-node.mjs";
import { requestJson } from "./http-client.mjs";
import { createPeerRequest, verifyPeerRequest, verifyPeerResponse } from "./peer-auth.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY = resolve(HERE, "..");
const NETWORK_CLI = join(HERE, "network-cli.mjs");
const RUNTIMES = Object.freeze([
  { component: "validator", entrypoint: "blockchain/network-cli.mjs", exercised: true,
    interface: "serve-validator" },
  { component: "finality", entrypoint: "blockchain/distributed-node.mjs", exercised: true,
    interface: "DistributedCoordinator" },
  { component: "beacon", entrypoint: "blockchain/beacon-service.mjs", exercised: false,
    interface: "beacon HTTP service" },
  { component: "archive", entrypoint: "blockchain/archive-cli.mjs", exercised: false,
    interface: "archive:serve" },
]);
const FORMAT = "nir-real-validator-recovery-rehearsal-v1";
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_DISK_BYTES = 64 * 1024 * 1024;
const LOOPBACK = "127.0.0.1";

function digest(value) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema is invalid`);
  }
}
function deadline(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
}
function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }

function inventory() {
  return RUNTIMES.map((runtime) => {
    const path = join(REPOSITORY, runtime.entrypoint); let available = false;
    try { const metadata = lstatSync(path); available = metadata.isFile() && !metadata.isSymbolicLink(); }
    catch {}
    return { ...runtime, available };
  });
}

async function reserveContiguousPorts() {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const first = 20_000 + Math.floor(Math.random() * 20_000); const servers = [];
    try {
      for (let offset = 0; offset < 4; offset += 1) {
        const server = createServer(); servers.push(server);
        await new Promise((resolvePromise, reject) => {
          server.once("error", reject); server.listen(first + offset, LOOPBACK, resolvePromise);
        });
      }
      return { first, servers };
    } catch {
      await Promise.all(servers.filter(({ listening }) => listening).map((server) =>
        new Promise((resolvePromise) => server.close(resolvePromise))));
    }
  }
  throw new Error("four bounded contiguous loopback ports are unavailable");
}

async function reserveExactPort(port) {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject); server.listen(port, LOOPBACK, resolvePromise);
  });
  return server;
}

class ValidatorProcess {
  constructor(child, index, port, limits) {
    this.child = child; this.index = index; this.port = port; this.exited = false;
    this.outputBytes = 0;
    this.stderr = "";
    const consume = (chunk, stderr = false) => {
      this.outputBytes += chunk.length;
      if (stderr && this.stderr.length < 4_096) {
        this.stderr += chunk.toString("utf8", 0, Math.max(0, 4_096 - this.stderr.length));
      }
      if (this.outputBytes > limits.maxOutputBytes) {
        this.failure = new Error("real validator output limit exceeded");
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
    };
    child.stdout.on("data", (chunk) => consume(chunk));
    child.stderr.on("data", (chunk) => consume(chunk, true));
    child.once("error", (error) => { this.spawnError = error; });
    child.once("exit", (code, signal) => { this.exited = true; this.exit = { code, signal }; });
  }
}

function startupExitError(record) {
  const category = /EADDRINUSE|address already in use/i.test(record.stderr) ? "PORT_IN_USE"
    : /ENOENT|no such file or directory/i.test(record.stderr) ? "INPUT_MISSING"
      : record.exit?.signal ? "SIGNAL" : record.exit?.code ? "EXIT_CODE" : "PROCESS_EXIT";
  return new Error(`real validator exited during startup (category=${category} code=${
    record.exit?.code ?? "none"} signal=${record.exit?.signal ?? "none"})`);
}

function reservationDescriptor(server) {
  const descriptor = server?.listening ? server?._handle?.fd : null;
  if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
    throw new Error("real validator port reservation descriptor is unavailable");
  }
  return descriptor;
}

function spawnValidator(directory, port, index, limits, reservation = null) {
  const stdio = ["ignore", "pipe", "pipe"];
  const env = { NIR_CERTIFICATE_MODE: "dev-genesis" };
  if (reservation !== null) {
    stdio.push(reservationDescriptor(reservation));
    env.NIR_LISTEN_FD = "3";
  }
  const child = spawn(process.execPath, [NETWORK_CLI, "serve-validator", directory, String(port)], {
    cwd: REPOSITORY, detached: true, env, shell: false, stdio,
  });
  return new ValidatorProcess(child, index, port, limits);
}

async function publicHealth(port, timeoutMs) {
  const response = await requestJson(`http://${LOOPBACK}:${port}/health`, {
    maxResponseBytes: 8 * 1024, timeoutMs,
  });
  if (!response.ok || response.body?.status !== "ready") throw new Error("validator is not ready");
  return response.body;
}

async function waitReady(processRecord, expectedHeight, limits) {
  const end = Date.now() + limits.startupTimeoutMs; let lastError;
  while (Date.now() < end) {
    if (processRecord.failure) throw processRecord.failure;
    if (processRecord.spawnError) throw new Error("real validator process failed to spawn");
    if (processRecord.exited) throw startupExitError(processRecord);
    try {
      const body = await publicHealth(processRecord.port, Math.min(250, limits.requestTimeoutMs));
      if (body.height === expectedHeight) return body;
      lastError = new Error("validator started at an unexpected height");
    } catch (error) { lastError = error; }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw lastError ?? new Error("real validator startup timed out");
}

async function stopGroup(processRecord, limits) {
  if (processRecord.exited) return { forced: false, stopped: true };
  try { process.kill(-processRecord.child.pid, "SIGTERM"); }
  catch (error) { if (error.code !== "ESRCH") return { forced: false, stopped: false }; }
  const graceful = await deadline(new Promise((resolvePromise) =>
    processRecord.child.once("exit", () => resolvePromise(true))), limits.shutdownTimeoutMs,
  "real validator shutdown").catch(() => false);
  if (graceful || processRecord.exited) return { forced: false, stopped: true };
  try { process.kill(-processRecord.child.pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") return { forced: true, stopped: false }; }
  const forced = await deadline(new Promise((resolvePromise) =>
    processRecord.child.once("exit", () => resolvePromise(true))), limits.shutdownTimeoutMs,
  "forced validator shutdown").catch(() => false);
  return { forced: true, stopped: forced || processRecord.exited };
}

async function authenticatedHealth(url, networkId, coordinatorWallet, validator) {
  const path = "/v1/health"; const payload = {};
  const auth = createPeerRequest({ body: payload, networkId, path, wallet: coordinatorWallet });
  const envelope = { auth, payload };
  const response = await requestJson(`${url}${path}`, {
    body: envelope, maxResponseBytes: 16 * 1024, method: "POST", timeoutMs: 2_000,
  });
  if (!response.ok) throw new Error("authenticated validator health request failed");
  const result = verifyPeerResponse({ auth: response.body.auth, networkId,
    requestNonce: auth.nonce, result: response.body.result, trustedPeer: validator });
  return { request: envelope, response: response.body, result };
}

async function replayHealth(url, signedHealth) {
  const response = await requestJson(`${url}/v1/health`, {
    body: signedHealth.request, maxResponseBytes: 8 * 1024, method: "POST", timeoutMs: 2_000,
  });
  return { rejected: !response.ok, status: response.status };
}

function diskBytes(root) {
  let total = 0; const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop(); const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error("real rehearsal state contains a symlink");
    if (metadata.isDirectory()) for (const name of readdirSync(path)) pending.push(join(path, name));
    else if (metadata.isFile()) total += metadata.size;
    else throw new Error("real rehearsal state contains a special file");
    if (total > MAX_DISK_BYTES) throw new Error("real rehearsal disk limit exceeded");
  }
  return total;
}

async function cleanup(records, root, limits) {
  const outcomes = await Promise.all(records.map((record) => stopGroup(record, limits)));
  const report = { attempted: records.length, failures: outcomes.filter(({ stopped }) => !stopped).length,
    forced: outcomes.filter(({ forced }) => forced).length, rootRemoved: false, status: "FAIL" };
  try { rmSync(root, { force: true, recursive: true }); report.rootRemoved = true; } catch {}
  report.status = report.failures === 0 && report.rootRemoved ? "PASS" : "FAIL";
  return report;
}

function reportPayload(fields) {
  return { ...fields, format: FORMAT, version: 1 };
}

function verifySignedHealth(value, networkId, coordinator, validator) {
  exact(value, ["request", "response", "result"], "signed health observation");
  exact(value.request, ["auth", "payload"], "signed health request");
  exact(value.request.auth, ["bodyHash", "method", "networkId", "nonce", "path", "signature",
    "signer", "timestamp"], "signed health request authentication");
  exact(value.response, ["auth", "result"], "signed health response");
  exact(value.response.auth, ["networkId", "requestNonce", "resultHash", "signature", "signer"],
    "signed health response authentication");
  exact(value.result, ["address", "certificateMode", "height", "networkId", "tipHash"],
    "signed health result");
  verifyPeerRequest({ auth: value.request?.auth, body: value.request?.payload,
    method: "POST", networkId, now: value.request?.auth?.timestamp, path: "/v1/health",
    seenNonces: new Map(), trustedPeer: coordinator });
  const verified = verifyPeerResponse({ auth: value.response?.auth, networkId,
    requestNonce: value.request?.auth?.nonce, result: value.response?.result,
    trustedPeer: validator });
  if (canonicalJson(verified) !== canonicalJson(value.result) ||
      value.request?.payload && Object.keys(value.request.payload).length !== 0 ||
      value.request?.auth?.signer !== coordinator.address || value.request?.auth?.path !== "/v1/health") {
    throw new Error("signed health observation binding is invalid");
  }
  return verified;
}

export function validateRealValidatorRecoveryReport(value) {
  exact(value, ["blocks", "completedAt", "controller", "format", "genesis", "inventory",
    "networkId", "observations", "startedAt", "targetValidator", "transcriptHash", "version"],
  "real validator recovery report");
  if (value.format !== FORMAT || value.version !== 1 || value.networkId !== value.genesis?.networkId ||
      !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.completedAt) ||
      value.completedAt < value.startedAt || value.completedAt - value.startedAt > 60_000 ||
      !Array.isArray(value.inventory) || value.inventory.length !== RUNTIMES.length ||
      !Array.isArray(value.blocks) || value.blocks.length !== 2 ||
      !/^nir1[0-9a-f]{64}$/.test(value.targetValidator ?? "")) {
    throw new Error("real validator recovery report header is invalid");
  }
  const unsigned = structuredClone(value); delete unsigned.transcriptHash;
  if (value.transcriptHash !== digest(unsigned)) throw new Error("real rehearsal transcript was mutated");
  const chain = new NirChain(value.genesis);
  for (const block of value.blocks) chain.appendBlock(block);
  const validator = value.genesis.validators.find(({ address }) => address === value.targetValidator);
  if (!validator) throw new Error("recovery target is not a genesis validator");
  exact(value.controller, ["newProcessId", "oldProcessId", "outageConnectionFailed",
    "replayRejected", "replayStatus", "sync"], "real rehearsal controller evidence");
  exact(value.controller.sync, ["height", "syncedBlocks", "tipHash"],
    "real rehearsal synchronization evidence");
  if (!value.controller.outageConnectionFailed || !value.controller.replayRejected ||
      value.controller.replayStatus < 400 || value.controller.replayStatus > 499 ||
      !Number.isSafeInteger(value.controller.oldProcessId) ||
      !Number.isSafeInteger(value.controller.newProcessId) ||
      value.controller.oldProcessId === value.controller.newProcessId ||
      !Number.isSafeInteger(value.controller.sync.syncedBlocks) ||
      value.controller.sync.syncedBlocks < 1 ||
      value.controller.sync?.height !== chain.height || value.controller.sync?.tipHash !== chain.tipHash) {
    throw new Error("real rehearsal controller evidence is incomplete");
  }
  const coordinator = value.observations?.coordinator;
  exact(value.observations, ["afterRecovery", "afterRestart", "beforeOutage", "coordinator"],
    "real rehearsal observations");
  exact(coordinator, ["address", "algorithm", "publicKey"], "coordinator identity");
  const pre = verifySignedHealth(value.observations?.beforeOutage,
    value.networkId, coordinator, validator);
  const restarted = verifySignedHealth(value.observations?.afterRestart,
    value.networkId, coordinator, validator);
  const recovered = verifySignedHealth(value.observations?.afterRecovery,
    value.networkId, coordinator, validator);
  if (pre.address !== validator.address || restarted.address !== validator.address ||
      recovered.address !== validator.address || pre.height !== 1 || restarted.height !== 1 ||
      recovered.height !== 2 || recovered.tipHash !== chain.tipHash ||
      restarted.tipHash !== pre.tipHash || recovered.networkId !== value.networkId) {
    throw new Error("signed validator recovery observations do not prove the expected transition");
  }
  const observationNonces = [value.observations.beforeOutage, value.observations.afterRestart,
    value.observations.afterRecovery].map(({ request }) => request.auth.nonce);
  if (new Set(observationNonces).size !== observationNonces.length ||
      value.observations.afterRestart.request.auth.timestamp <
        value.observations.beforeOutage.request.auth.timestamp ||
      value.observations.afterRecovery.request.auth.timestamp <
        value.observations.afterRestart.request.auth.timestamp) {
    throw new Error("signed validator recovery observations are replayed or out of order");
  }
  if (!value.inventory.every((entry, index) => canonicalJson(entry) === canonicalJson({
    ...RUNTIMES[index], available: true,
  }))) throw new Error("real runtime inventory is unavailable or mutated");
  return { authenticatedRecovery: true, blockHeight: chain.height, format: FORMAT,
    harnessStatus: "PASS", scenarioStatus: "PASS", targetValidator: validator.address,
    tipHash: chain.tipHash, transcriptHash: value.transcriptHash, version: 1 };
}

export async function runRealValidatorRecoveryRehearsal(options = {}) {
  const limits = { maxOutputBytes: options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
    requestTimeoutMs: options.requestTimeoutMs ?? 2_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 750,
    startupTimeoutMs: options.startupTimeoutMs ?? 8_000 };
  for (const [name, value] of Object.entries(limits)) {
    const maximum = name === "maxOutputBytes" ? 1024 * 1024 : 30_000;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`real rehearsal ${name} is invalid`);
    }
  }
  const runtimeInventory = inventory();
  if (runtimeInventory.some(({ available }) => !available)) {
    const error = new Error("required local NIR runtime is unavailable");
    error.code = "ERR_RUNTIME_UNAVAILABLE";
    error.runtimeInventory = runtimeInventory;
    throw error;
  }
  const root = mkdtempSync(join(tmpdir(), "nir-real-recovery-"));
  const records = []; let failure; let result; let reservations;
  try {
    reservations = await reserveContiguousPorts();
    const networkInitializer = options._networkInitializer ?? initializeDistributedDevnet;
    if (typeof networkInitializer !== "function") throw new Error("network initializer is invalid");
    const layout = networkInitializer(join(root, "network"), {
      firstValidatorPort: reservations.first, networkId: "nir-real-recovery-devnet",
    });
    for (let index = 0; index < 4; index += 1) {
      await options._beforeStart?.({ index, port: reservations.first + index });
      const record = spawnValidator(layout.validatorDirectories[index],
        reservations.first + index, index, limits, reservations.servers[index]);
      records[index] = record;
      await new Promise((resolvePromise) => reservations.servers[index].close(resolvePromise));
      await options._afterPortRelease?.({ index, port: reservations.first + index,
        processId: record.child.pid });
      await waitReady(record, 0, limits);
    }
    if (options._crashAfterStart !== undefined) {
      const crashTarget = records[options._crashAfterStart];
      if (!crashTarget) throw new Error("injected crash target is invalid");
      process.kill(-crashTarget.child.pid, "SIGKILL");
      await deadline(new Promise((resolvePromise) => crashTarget.child.once("exit", resolvePromise)),
        limits.shutdownTimeoutMs, "injected validator crash");
      throw new Error("injected real validator crash");
    }
    const genesis = readJson(join(layout.coordinatorDirectory, "genesis.json"));
    const treasury = readJson(join(layout.coordinatorDirectory, "TREASURY-DEV-KEY.json"));
    const coordinatorWallet = readJson(join(layout.coordinatorDirectory, "COORDINATOR-KEY.json"));
    const coordinator = new DistributedCoordinator(layout.coordinatorDirectory, layout.validatorUrls);
    const submit = async (nonce) => {
      const transaction = createTransfer({ amount: "1", fee: "1000", networkId: genesis.networkId,
        nonce, recipient: genesis.evaluators[0].address, wallet: treasury });
      await coordinator.submitTransaction(transaction); return coordinator.produceBlock();
    };
    await submit(0);
    const current = loadBlockStore(layout.coordinatorDirectory, genesis).chain;
    const nextProposer = current.expectedProposer(current.height + 1, 0);
    const targetIndex = genesis.validators.findIndex(({ address }) => address !== nextProposer);
    const target = genesis.validators[targetIndex];
    const beforeOutage = await authenticatedHealth(layout.validatorUrls[targetIndex],
      genesis.networkId, coordinatorWallet, target);
    const replay = await replayHealth(layout.validatorUrls[targetIndex], beforeOutage);
    if (!replay.rejected) throw new Error("real validator accepted a replayed health request");
    const oldProcessId = records[targetIndex].child.pid;
    const stopped = await stopGroup(records[targetIndex], limits);
    if (!stopped.stopped) throw new Error("outage target did not stop");
    let outageConnectionFailed = false;
    try { await publicHealth(records[targetIndex].port, 200); } catch { outageConnectionFailed = true; }
    if (!outageConnectionFailed) throw new Error("stopped validator remained reachable");
    await submit(1);
    const replacementReservation = await reserveExactPort(reservations.first + targetIndex);
    const replacement = spawnValidator(layout.validatorDirectories[targetIndex],
      reservations.first + targetIndex, targetIndex, limits, replacementReservation);
    records.push(replacement);
    await new Promise((resolvePromise) => replacementReservation.close(resolvePromise));
    await options._afterRestartPortRelease?.({ index: targetIndex,
      port: reservations.first + targetIndex, processId: replacement.child.pid });
    await waitReady(replacement, 1, limits);
    const afterRestart = await authenticatedHealth(layout.validatorUrls[targetIndex],
      genesis.networkId, coordinatorWallet, target);
    const syncResponse = await requestJson(`${layout.validatorUrls[targetIndex]}/v1/sync`, {
      method: "POST", timeoutMs: limits.requestTimeoutMs,
    });
    if (!syncResponse.ok || syncResponse.body?.height !== 2) {
      throw new Error("real validator synchronization failed");
    }
    const afterRecovery = await authenticatedHealth(layout.validatorUrls[targetIndex],
      genesis.networkId, coordinatorWallet, target);
    const chain = loadBlockStore(layout.coordinatorDirectory, genesis).chain;
    const fields = reportPayload({ blocks: chain.blocks().slice(1), completedAt: Date.now(),
      controller: { newProcessId: replacement.child.pid, oldProcessId, outageConnectionFailed,
        replayRejected: replay.rejected, replayStatus: replay.status,
        sync: { height: syncResponse.body.height, syncedBlocks: syncResponse.body.syncedBlocks,
          tipHash: syncResponse.body.tipHash } },
      genesis, inventory: runtimeInventory, networkId: genesis.networkId,
      observations: { afterRecovery, afterRestart, beforeOutage,
        coordinator: publicWallet(coordinatorWallet) }, startedAt: beforeOutage.request.auth.timestamp,
      targetValidator: target.address });
    const report = { ...fields, transcriptHash: digest(fields) };
    const validation = validateRealValidatorRecoveryReport(report);
    result = { diskBytes: diskBytes(root), report, validation };
  } catch (error) { failure = error; }
  if (reservations) for (const server of reservations.servers) if (server.listening) {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
  const cleanupReport = await cleanup(records.filter(Boolean), root, limits);
  if (failure || cleanupReport.status !== "PASS") {
    const error = failure ?? new Error("real rehearsal cleanup failed closed");
    error.cleanupReport = cleanupReport; throw error;
  }
  return { ...result, cleanup: cleanupReport };
}
