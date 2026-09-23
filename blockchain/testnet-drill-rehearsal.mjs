import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, readdirSync,
  rmSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

import { generateWallet, publicWallet } from "./crypto.mjs";
import {
  createTestnetPartitionDrillEvidence, createTestnetPartitionDrillPlan,
  validateTestnetPartitionDrillEvidence,
} from "./testnet-partition-drill.mjs";

const ADAPTER_PATH = join(dirname(fileURLToPath(import.meta.url)), "testnet-drill-adapter.mjs");
const MAX_PROCESSES = 16;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_TEMP_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const LOOPBACK = "127.0.0.1";

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

function deadline(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, resolvePromise);
  });
  const port = server.address().port;
  return { close: () => new Promise((resolvePromise) => server.close(resolvePromise)), port };
}

function health(port, timeoutMs) {
  return deadline(new Promise((resolvePromise, reject) => {
    const call = request({ host: LOOPBACK, method: "GET", path: "/health", port }, (response) => {
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 4096) call.destroy(new Error("adapter health response is oversized"));
      });
      response.on("end", () => response.statusCode === 200 ? resolvePromise() :
        reject(new Error("adapter health check failed")));
    });
    call.once("error", reject); call.end();
  }), timeoutMs, "adapter health check");
}

class Adapter {
  constructor(child, identity, port, limits) {
    this.child = child; this.identity = identity; this.port = port; this.limits = limits;
    this.pending = new Map(); this.sequence = 0; this.outputBytes = 0; this.exited = false;
    child.on("message", (message) => {
      const pending = this.pending.get(message?.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error("adapter request failed"); error.code = message.error.code;
        pending.reject(error);
      } else pending.resolve(message.result);
    });
    child.once("exit", (code, signal) => {
      this.exited = true; this.exit = { code, signal };
      for (const pending of this.pending.values()) pending.reject(new Error("adapter exited"));
      this.pending.clear();
    });
    const consume = (chunk) => {
      this.outputBytes += chunk.length;
      if (this.outputBytes > limits.maxOutputBytes) {
        this.failure = new Error("adapter output limit exceeded");
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
    };
    child.stdout.on("data", consume); child.stderr.on("data", consume);
  }

  rpc(type, fields = {}, timeoutMs = this.limits.rpcTimeoutMs) {
    if (this.exited || this.failure || !this.child.connected) {
      return Promise.reject(this.failure ?? new Error("adapter is unavailable"));
    }
    const id = `${this.child.pid}:${++this.sequence}`;
    return deadline(new Promise((resolvePromise, reject) => {
      this.pending.set(id, { reject, resolve: resolvePromise });
      this.child.send({ ...fields, id, type }, (error) => {
        if (!error) return;
        this.pending.delete(id); reject(error);
      });
    }), timeoutMs, "adapter RPC").finally(() => this.pending.delete(id));
  }
}

class FaultProxy {
  constructor(adapters, timeoutMs, scenarioId) {
    this.adapters = adapters; this.timeoutMs = timeoutMs; this.events = [];
    this.groups = null; this.dropped = new Set(); this.scenarioId = scenarioId; this.sequence = 0;
  }
  partition(groups) { this.groups = groups.map((group) => new Set(group)); }
  heal() { this.groups = null; this.dropped.clear(); }
  drop(operatorId) { this.dropped.add(operatorId); }
  allowed(from, to) {
    if (this.dropped.has(from) || this.dropped.has(to)) return false;
    return !this.groups || this.groups.some((group) => group.has(from) && group.has(to));
  }
  async deliver(from, to, label, { delayMs = 0, kind = "message", replay = false,
    sequence } = {}) {
    if (!this.allowed(from, to)) {
      this.events.push({ from, label, outcome: "dropped", to }); return false;
    }
    const sentAt = Date.now();
    if (delayMs > 0) await deadline(new Promise((resolvePromise) =>
      setTimeout(resolvePromise, delayMs)), this.timeoutMs, "fault delay");
    const target = this.adapters.get(to); const token = digest(`${from}:${to}:${label}`);
    const fields = { digest: token, kind, scenarioId: this.scenarioId,
      sentAt, sequence: sequence ?? ++this.sequence };
    const first = await target.rpc("ping", fields);
    if (first.digest !== token) throw new Error("fault proxy delivery was corrupted");
    if (replay) {
      try { await target.rpc("ping", fields); throw new Error("replayed message was accepted"); }
      catch (error) { if (error.code !== "REPLAY_REJECTED") throw error; }
    }
    this.events.push({ delayed: delayMs > 0, from, label,
      outcome: replay ? "replay-rejected" : "delivered", to });
    return true;
  }
  hash(scenarioId) { return digest(JSON.stringify({ events: this.events, scenarioId })); }
}

function identity(wallet, operatorId) { return { ...publicWallet(wallet), operatorId }; }

function createParticipants(networkId, releaseCheckpointHash) {
  const privateByOperator = new Map();
  const make = (count, prefix) => Array.from({ length: count }, (_, index) => {
    const wallet = generateWallet(); const operatorId = `${prefix}-${index}`;
    privateByOperator.set(operatorId, wallet); return identity(wallet, operatorId);
  });
  const validators = make(4, "validator");
  return { privateByOperator, topology: {
    archives: make(2, "archive"), beacons: make(4, "beacon"),
    certificateRotation: { newPin: digest("rehearsal-new-pin"),
      oldPin: digest("rehearsal-old-pin"), overlapEndHeight: 110,
      overlapStartHeight: 100, validator: validators[0].address },
    format: "nir-testnet-drill-topology-v1", networkId, releaseCheckpointHash,
    validators, version: 1,
  } };
}

function releaseCheckpoint(preflight) {
  const value = preflight?.checks?.find(({ id }) => id === "release")?.details?.checkpointHash;
  if (typeof value !== "string") throw new Error("preflight release checkpoint is missing");
  return value;
}

async function startAdapters(topology, privateByOperator, root, limits, hooks, owned) {
  const roles = [["validator", topology.validators], ["beacon", topology.beacons],
    ["archive", topology.archives]];
  let index = 0;
  for (const [role, identities] of roles) for (const participant of identities) {
    if (owned.length >= MAX_PROCESSES) throw new Error("rehearsal process bound exceeded");
    const reservation = await reservePort();
    try {
      await hooks?._beforeSpawn?.({ index, operatorId: participant.operatorId,
        port: reservation.port, role });
    } finally { await reservation.close(); }
    await hooks?._afterPortRelease?.({ index, operatorId: participant.operatorId,
      port: reservation.port, role });
    const child = spawn(process.execPath, [ADAPTER_PATH], {
      cwd: root, detached: true, env: {}, shell: false,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const adapter = new Adapter(child, participant, reservation.port, limits);
    owned.push(adapter);
    await adapter.rpc("init", { host: LOOPBACK, operatorId: participant.operatorId,
      port: reservation.port, role, wallet: privateByOperator.get(participant.operatorId) },
    limits.startupTimeoutMs);
    await health(reservation.port, limits.startupTimeoutMs);
    index += 1;
  }
}

async function waitExit(adapter, timeoutMs) {
  if (adapter.exited) return true;
  return deadline(new Promise((resolvePromise) => adapter.child.once("exit", () =>
    resolvePromise(true))), timeoutMs, "adapter shutdown").catch(() => false);
}

async function cleanup(owned, root, limits) {
  const report = { attempted: owned.length, exited: 0, failures: [], forced: 0,
    rootRemoved: false, status: "FAIL" };
  for (const adapter of owned) if (!adapter.exited) {
    try { process.kill(-adapter.child.pid, "SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") report.failures.push("terminate-failed"); }
  }
  for (const adapter of owned) {
    if (!await waitExit(adapter, limits.shutdownTimeoutMs) && !adapter.exited) {
      report.forced += 1;
      try { process.kill(-adapter.child.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") report.failures.push("kill-failed"); }
      await waitExit(adapter, limits.shutdownTimeoutMs);
    }
    if (adapter.exited) report.exited += 1; else report.failures.push("process-remained");
  }
  try { rmSync(root, { force: true, recursive: true }); report.rootRemoved = true; }
  catch { report.failures.push("temp-root-remove-failed"); }
  report.status = report.failures.length === 0 && report.exited === report.attempted &&
    report.rootRemoved ? "PASS" : "FAIL";
  return report;
}

function tempBytes(root) {
  let total = 0; const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop(); const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("rehearsal temp root contains a symlink");
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) pending.push(join(path, name));
    } else if (stat.isFile()) total += stat.size;
    else throw new Error("rehearsal temp root contains a special file");
    if (total > MAX_TEMP_BYTES) throw new Error("rehearsal disk limit exceeded");
  }
  return total;
}

function participantMap(plan, adapters) {
  return new Map([...plan.topology.validators, ...plan.topology.beacons,
    ...plan.topology.archives].map((entry) => [entry.operatorId,
      adapters.find((adapter) => adapter.identity.operatorId === entry.operatorId)]));
}

async function exerciseScenario(plan, scenario, proxy, adapters, hooks, limits) {
  if (hooks?._hangScenario === scenario.id) await new Promise(() => {});
  const operators = scenario.requiredObservations.map(({ operatorId }) => operatorId);
  const unique = [...new Set(operators)];
  if (scenario.type === "validator-outage") {
    proxy.drop(unique.at(-1));
    await proxy.deliver(unique[0], unique[1], "continue"); proxy.heal();
    await proxy.deliver(unique[0], unique.at(-1), "catchup");
  } else if (scenario.type === "two-two-partition") {
    const groups = scenario.partitions.map((addresses) => addresses.map((address) =>
      plan.topology.validators.find((value) => value.address === address).operatorId));
    proxy.partition(groups); await proxy.deliver(groups[0][0], groups[1][0], "blocked"); proxy.heal();
  } else if (scenario.type === "three-one-partition") {
    const groups = scenario.partitions.map((addresses) => addresses.map((address) =>
      plan.topology.validators.find((value) => value.address === address).operatorId));
    proxy.partition(groups); await proxy.deliver(groups[0][0], groups[0][1], "majority");
    await proxy.deliver(groups[0][0], groups[1][0], "isolated"); proxy.heal();
    await proxy.deliver(groups[0][0], groups[1][0], "catchup");
  } else if (scenario.type === "message-adversary") {
    if (!hooks?._skipMessageEvents) for (const operatorId of unique) {
      await proxy.deliver(unique[0], operatorId, `delayed:${operatorId}`,
        { delayMs: 5, kind: "delayed" });
      await proxy.deliver(unique[0], operatorId, `replay:${operatorId}`, { replay: true });
      await proxy.deliver(unique[0], operatorId, `order-high:${operatorId}`, { sequence: 100 });
      await proxy.deliver(unique[0], operatorId, `order-low:${operatorId}`, { sequence: 99 });
      await proxy.deliver(unique[0], operatorId, `healed:${operatorId}`, { kind: "healed" });
    }
  } else if (scenario.type === "beacon-outage") {
    proxy.drop(unique[0]); await proxy.deliver(unique[1], unique[0], "outage"); proxy.heal();
    await proxy.deliver(unique[1], unique[0], "recover");
  } else if (scenario.type === "archive-corruption") {
    proxy.events.push({ digest: digest("corrupt"), outcome: "corrupt-rejected" });
    await proxy.deliver(unique[1], unique[0], "alternate-source");
  } else if (scenario.type === "certificate-rotation-overlap") {
    const rotation = plan.topology.certificateRotation;
    if (rotation.oldPin === rotation.newPin || rotation.overlapEndHeight < rotation.overlapStartHeight) {
      throw new Error("certificate overlap simulation is invalid");
    }
    proxy.events.push({ outcome: "both-pins-in-overlap" }, { outcome: "old-pin-expired" });
    await proxy.deliver(unique[0], unique[1], "post-rotation");
  }
  if (hooks?._crashScenario === scenario.id) {
    await adapters.get(unique[0]).rpc("crash").catch(() => {});
    throw new Error("injected adapter crash");
  }
  return deadline(Promise.resolve(proxy.hash(scenario.id)), limits.scenarioTimeoutMs,
    `scenario ${scenario.id}`);
}

async function buildEvidence(plan, adapters, limits, hooks) {
  const startedAt = Date.now(); const scenarios = [];
  for (let index = 0; index < plan.scenarios.length; index += 1) {
    const scenario = plan.scenarios[index];
    const scenarioOperators = [...new Set(scenario.requiredObservations.map(({ operatorId }) =>
      operatorId))];
    await Promise.all(scenarioOperators.map((operatorId) => adapters.get(operatorId)
      .rpc("scenario-start", { scenarioId: scenario.id })));
    const proxy = new FaultProxy(adapters, limits.rpcTimeoutMs, scenario.id);
    await deadline(exerciseScenario(plan, scenario, proxy, adapters, hooks, limits),
      limits.scenarioTimeoutMs, `scenario ${scenario.id}`);
    const observations = [];
    for (const required of scenario.requiredObservations) observations.push(
      await adapters.get(required.operatorId).rpc("sign-observation", {
        observationId: required.id, plan, scenarioId: scenario.id,
      }));
    const quorumHashes = [];
    const outcome = observations.every(({ result }) => result === "PASS") ? "PASS" : "FAIL";
    scenarios.push({ id: scenario.id, observations, outcome, quorumHashes });
  }
  const completedAt = Date.now();
  return createTestnetPartitionDrillEvidence({ completedAt, networkId: plan.networkId,
    planHash: plan.planHash, releaseCheckpointHash: plan.releaseCheckpointHash, scenarios,
    startedAt });
}

export async function runLocalTestnetPartitionRehearsal(preflight, options = {}) {
  const limits = {
    maxOutputBytes: options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
    rpcTimeoutMs: options.rpcTimeoutMs ?? 2_000,
    scenarioTimeoutMs: options.scenarioTimeoutMs ?? 3_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 750,
    startupTimeoutMs: options.startupTimeoutMs ?? 3_000,
  };
  for (const [name, value] of Object.entries(limits)) {
    const maximum = name === "maxOutputBytes" ? 1024 * 1024 : 60_000;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`rehearsal ${name} is invalid`);
    }
  }
  const root = mkdtempSync(join(tmpdir(), "nir-testnet-rehearsal-"));
  const owned = []; let result; let failure;
  try {
    const participants = createParticipants(preflight?.networkId, releaseCheckpoint(preflight));
    const plan = createTestnetPartitionDrillPlan(preflight, participants.topology);
    await startAdapters(plan.topology, participants.privateByOperator, root, limits, options, owned);
    if (options._crashAfterStart !== undefined) {
      const target = owned[options._crashAfterStart];
      if (!target) throw new Error("crash injection target is invalid");
      await target.rpc("crash").catch(() => {}); throw new Error("injected adapter crash");
    }
    if (options._spamAfterStart !== undefined) {
      await owned[options._spamAfterStart].rpc("spam").catch(() => {});
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      if (owned[options._spamAfterStart].failure) throw owned[options._spamAfterStart].failure;
    }
    const adapters = participantMap(plan, owned);
    const evidence = await buildEvidence(plan, adapters, limits, options);
    const validation = validateTestnetPartitionDrillEvidence(plan, evidence, { now: Date.now() });
    if (validation.status !== "FAIL") {
      throw new Error("adapter harness cannot authenticate a real drill PASS");
    }
    const diskBytes = tempBytes(root);
    if (diskBytes > MAX_TEMP_BYTES) throw new Error("rehearsal disk limit exceeded");
    result = { evidence, plan, rehearsal: { adapterCount: owned.length,
      authenticatedDrillStatus: validation.status, diskBytes, externalNetwork: false,
      faultLayer: "application", harnessStatus: "PASS" }, validation };
  } catch (error) { failure = error; }
  const cleanupReport = await cleanup(owned, root, limits);
  if (failure || cleanupReport.status !== "PASS") {
    const error = failure ?? new Error("rehearsal cleanup failed closed");
    error.cleanupReport = cleanupReport; throw error;
  }
  return { ...result, cleanup: cleanupReport };
}

function secureRead(pathValue) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    throw new Error("secure no-follow rehearsal input is unavailable");
  }
  const path = resolve(pathValue);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const linked = lstatSync(path); const before = fstatSync(descriptor);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 2 || before.size > MAX_INPUT_BYTES) {
      throw new Error("rehearsal input is unsafe");
    }
    if (linked.dev !== before.dev || linked.ino !== before.ino) {
      throw new Error("rehearsal input changed during open");
    }
    const buffer = Buffer.alloc(before.size); let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) throw new Error("rehearsal input changed during read");
      offset += count;
    }
    const openedAfter = fstatSync(descriptor); const linkedAfter = lstatSync(path);
    if (before.dev !== openedAfter.dev || before.ino !== openedAfter.ino ||
        before.size !== openedAfter.size || before.mtimeMs !== openedAfter.mtimeMs ||
        before.ctimeMs !== openedAfter.ctimeMs || before.dev !== linkedAfter.dev ||
        before.ino !== linkedAfter.ino || before.size !== linkedAfter.size ||
        before.mtimeMs !== linkedAfter.mtimeMs || before.ctimeMs !== linkedAfter.ctimeMs) {
      throw new Error("rehearsal input changed during read");
    }
    return JSON.parse(buffer.toString("utf8"));
  } finally { closeSync(descriptor); }
}

export async function runLocalTestnetPartitionRehearsalFile(path, options = {}) {
  return runLocalTestnetPartitionRehearsal(secureRead(path), options);
}
