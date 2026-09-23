#!/usr/bin/env node
import { createServer } from "node:http";

import {
  signTestnetDrillObservation,
} from "./testnet-partition-drill.mjs";
import { canonicalJson } from "./crypto.mjs";
import { createHash } from "node:crypto";

let wallet; let operatorId; let role; let server;
let currentScenario = null; let transcript = []; let seenDigests = new Set(); let flags = {};
const MAX_MESSAGES = 4096;

function reply(message, result, error = null) {
  if (process.connected) process.send({ error, id: message.id, result });
}

function failure(message, code) { const error = new Error(message); error.code = code; return error; }
function record(value) {
  if (transcript.length >= MAX_MESSAGES) throw failure("adapter transcript capacity reached", "CAPACITY");
  transcript.push(value);
}
function transcriptHash() {
  return createHash("sha256").update(canonicalJson({ operatorId, scenario: currentScenario,
    transcript })).digest("hex");
}
function derivedResult(id) {
  if (currentScenario !== "04-delayed-replayed-messages") return "FAIL";
  if (id.startsWith("delay-observed:")) return flags.delayed ? "PASS" : "FAIL";
  if (id.startsWith("duplicate-observed:") || id.startsWith("replay-rejected:")) {
    return flags.replayRejected ? "PASS" : "FAIL";
  }
  if (id.startsWith("reorder-observed:")) return flags.reordered ? "PASS" : "FAIL";
  // Receiving after heal is locally observable; consensus convergence is not.
  if (id.startsWith("converged:")) return "FAIL";
  return "FAIL";
}

process.on("message", async (message) => {
  try {
    if (message.type === "init") {
      if (wallet || message.host !== "127.0.0.1" || !Number.isSafeInteger(message.port)) {
        throw new Error("adapter initialization is invalid");
      }
      ({ operatorId, role, wallet } = message);
      server = createServer({ maxHeaderSize: 8 * 1024, requestTimeout: 2_000 },
        (request, response) => {
        if (request.method !== "GET" || request.url !== "/health") {
          response.writeHead(404).end(); return;
        }
        const body = JSON.stringify({ operatorId, role, status: "ready" });
        response.writeHead(200, { "content-length": Buffer.byteLength(body),
          "content-type": "application/json" });
        response.end(body);
      });
      server.maxConnections = 4;
      server.headersTimeout = 2_000;
      server.keepAliveTimeout = 500;
      await new Promise((resolve, reject) => {
        server.once("error", reject); server.listen(message.port, message.host, resolve);
      });
      reply(message, { operatorId, role, status: "ready" });
    } else if (message.type === "scenario-start") {
      if (!wallet || typeof message.scenarioId !== "string") {
        throw failure("scenario start is invalid", "INVALID_SCENARIO");
      }
      currentScenario = message.scenarioId; transcript = []; seenDigests = new Set(); flags = {};
      reply(message, { operatorId, scenarioId: currentScenario });
    } else if (message.type === "ping") {
      if (!wallet) throw new Error("adapter is not initialized");
      if (message.scenarioId !== currentScenario || typeof message.digest !== "string" ||
          message.digest.length !== 64 || !Number.isSafeInteger(message.sequence) ||
          message.sequence < 0 || typeof message.kind !== "string") {
        throw failure("adapter message is invalid", "INVALID_MESSAGE");
      }
      if (seenDigests.has(message.digest)) {
        flags.replayRejected = true; record({ digest: message.digest, outcome: "replay-rejected" });
        throw failure("replayed message rejected", "REPLAY_REJECTED");
      }
      seenDigests.add(message.digest);
      if (message.kind === "delayed" && Number.isSafeInteger(message.sentAt) &&
          Date.now() - message.sentAt >= 1) flags.delayed = true;
      if (Number.isSafeInteger(flags.lastSequence) && message.sequence < flags.lastSequence) {
        flags.reordered = true;
      }
      flags.lastSequence = message.sequence;
      if (message.kind === "healed") flags.healed = true;
      record({ digest: message.digest, kind: message.kind, outcome: "received",
        sequence: message.sequence });
      reply(message, { digest: message.digest, operatorId });
    } else if (message.type === "sign-observation") {
      if (message.scenarioId !== currentScenario || typeof message.observationId !== "string") {
        throw failure("observation is outside the active scenario", "UNOBSERVED");
      }
      const value = { evidenceHash: transcriptHash(), id: message.observationId,
        observedAt: Date.now(), result: derivedResult(message.observationId) };
      try {
        reply(message, signTestnetDrillObservation(message.plan, message.scenarioId, value, wallet));
      } catch (error) {
        throw failure(`observation derivation failed:${currentScenario}:${message.observationId}:${operatorId}`,
          "OBSERVATION_DERIVATION_FAILED");
      }
    } else if (message.type === "crash") {
      process.exit(73);
    } else if (message.type === "spam") {
      process.stdout.write("x".repeat(128 * 1024));
    } else throw new Error("adapter request type is invalid");
  } catch (error) { reply(message, null, { code: error.code ?? "ADAPTER_FAILURE" }); }
});

async function shutdown() {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
