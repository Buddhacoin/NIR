#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import process from "node:process";

import { blockHash, computeChainStateRoot, createTransfer, NirChain } from "./chain.mjs";
import { MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS, PROTOCOL_VERSION } from "./constants.mjs";
import { DistributedCoordinator, initializeDistributedDevnet } from "./distributed-node.mjs";
import { createPeerRequest } from "./peer-auth.mjs";
import { loadBlockStore } from "./block-store.mjs";

const FORMAT = "nir-protocol-upgrade-v1";
const CLI = new URL("./network-cli.mjs", import.meta.url).pathname;

function schedule(version, activationHeight) {
  return { activationHeight, format: FORMAT, version };
}

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }

async function waitHealth(url, { height = null, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
      const body = await response.json();
      if (response.ok && body.status === "ready" && (height === null || body.height === height)) return body;
      lastError = new Error(`validator height is ${body.height}; expected ${height}`);
    } catch (error) { lastError = error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`validator did not become ready: ${lastError?.message ?? "timeout"}`);
}

function startValidator(directory, port) {
  const child = spawn(process.execPath, [CLI, "serve-validator", directory, String(port)], {
    env: { ...process.env, NIR_CERTIFICATE_MODE: "dev-genesis" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk) => { output = `${output}${chunk}`.slice(-8_192); };
  child.stdout.on("data", collect); child.stderr.on("data", collect);
  child.rehearsalOutput = () => output;
  return child;
}

async function stopValidator(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function validatorRejectsProposal(url, proposal, networkId, coordinatorWallet) {
  const path = "/v1/proposals";
  const auth = createPeerRequest({ body: proposal, networkId, path, wallet: coordinatorWallet });
  const response = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth, payload: proposal }) });
  const body = await response.json();
  return { error: body.error ?? null, rejected: response.status === 400 };
}

/**
 * Local, valueless rehearsal. Validator keys and journals remain in separate directories and
 * every consensus vote is produced by a distinct child process.
 */
export async function runProtocolUpgradeRehearsal({ directory, firstValidatorPort = 18_791 } = {}) {
  if (typeof directory !== "string" || !directory || !Number.isSafeInteger(firstValidatorPort) ||
      firstValidatorPort < 1_024 || firstValidatorPort > 65_531) {
    throw new Error("rehearsal directory or validator port range is invalid");
  }
  const root = resolve(directory);
  mkdirSync(root, { recursive: false, mode: 0o700 });
  const layout = initializeDistributedDevnet(join(root, "network"), {
    firstValidatorPort, networkId: "nir-upgrade-rehearsal",
  });
  const genesis = readJson(join(layout.coordinatorDirectory, "genesis.json"));
  const treasury = readJson(join(layout.coordinatorDirectory, "TREASURY-DEV-KEY.json"));
  const coordinatorWallet = readJson(join(layout.coordinatorDirectory, "COORDINATOR-KEY.json"));
  const children = layout.validatorDirectories.map((validatorDirectory, index) =>
    startValidator(validatorDirectory, firstValidatorPort + index));
  const urls = layout.validatorUrls;
  try {
    await Promise.all(urls.map((url) => waitHealth(url, { height: 0 })));
    let coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    const currentChain = () => loadBlockStore(layout.coordinatorDirectory, genesis).chain;
    const queueAndProduce = async (options = {}) => {
      const chain = currentChain();
      const transaction = createTransfer({ amount: "1", fee: "1000", networkId: genesis.networkId,
        nonce: chain.nextNonce(treasury.address), recipient: genesis.evaluators[0].address, wallet: treasury });
      await coordinator.submitTransaction(transaction);
      return coordinator.produceBlock(options);
    };

    const activationHeight = 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
    await queueAndProduce({ protocolUpgrade: schedule(PROTOCOL_VERSION + 1, activationHeight) });
    while (coordinator.height < activationHeight - 2) await queueAndProduce();

    const preProbeChain = currentChain();
    const premature = preProbeChain.buildBlock({ transactions: [],
      timestamp: preProbeChain.blocks().at(-1).timestamp + 1 });
    premature.protocolVersion = PROTOCOL_VERSION + 1;
    const counterfactualState = preProbeChain.consensusSnapshot().state;
    counterfactualState.protocolVersion = PROTOCOL_VERSION + 1;
    counterfactualState.pendingProtocolUpgrade = null;
    counterfactualState.assets = [];
    counterfactualState.assetBalances = [];
    premature.stateRoot = computeChainStateRoot(counterfactualState);
    const prematureProposalHash = blockHash(premature);
    const prematureResults = await Promise.all(urls.map((url) =>
      validatorRejectsProposal(url, premature, genesis.networkId, coordinatorWallet)));
    if (prematureResults.some(({ rejected }) => !rejected)) throw new Error("a validator accepted a premature-version proposal");
    const prematureRejectionReason = "block protocol version does not match its activation height";
    if (prematureResults.some(({ error }) => error !== prematureRejectionReason)) {
      throw new Error(`premature proposal was not rejected by the protocol gate: ${JSON.stringify(prematureResults)}`);
    }

    await stopValidator(children[3]);
    await queueAndProduce();
    const preActivationChain = currentChain();
    if (preActivationChain.height !== activationHeight - 1 ||
        preActivationChain.protocolVersion !== PROTOCOL_VERSION) throw new Error("pre-activation state is invalid");

    const oldOnly = new NirChain(genesis, { supportedProtocolVersions: [PROTOCOL_VERSION] });
    for (const block of preActivationChain.blocks().slice(1)) oldOnly.appendBlock(block);
    await queueAndProduce();
    const activated = currentChain();
    const activationBlock = activated.blocks().at(-1);
    let oldBinaryError = null;
    try { oldOnly.appendBlock(activationBlock); } catch (error) { oldBinaryError = error.message; }
    if (!/unsupported protocol version/.test(oldBinaryError ?? "")) throw new Error("old binary did not fail closed at activation");
    if (activated.protocolVersion !== PROTOCOL_VERSION + 1 || activated.pendingProtocolUpgrade !== null) {
      throw new Error("scheduled protocol version did not activate exactly at its height");
    }
    const finalizedActivationHashes = activated.blocks().map(({ hash }) => hash);

    let downgradeError = null;
    try {
      activated.buildBlock({ transactions: [], protocolUpgrade: schedule(PROTOCOL_VERSION,
        activated.height + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS),
        timestamp: activated.blocks().at(-1).timestamp + 1 });
    } catch (error) { downgradeError = error.message; }
    if (!/schedule is invalid/.test(downgradeError ?? "")) throw new Error("finalized activation allowed a downgrade schedule");

    children[3] = startValidator(layout.validatorDirectories[3], firstValidatorPort + 3);
    await waitHealth(urls[3], { height: activationHeight - 2 });
    const recoveryActivationHeight = activationHeight + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
    await queueAndProduce({ protocolUpgrade: schedule(PROTOCOL_VERSION + 2, recoveryActivationHeight) });
    const caughtUp = await waitHealth(urls[3], { height: activationHeight + 1 });
    const afterRecoverySchedule = currentChain();
    if (caughtUp.protocolVersion !== PROTOCOL_VERSION + 1 ||
        caughtUp.pendingProtocolUpgrade?.version !== PROTOCOL_VERSION + 2) {
      throw new Error("restarted validator did not catch up across activation and recovery schedule");
    }

    if (finalizedActivationHashes.some((hash, index) => afterRecoverySchedule.blocks()[index]?.hash !== hash)) {
      throw new Error("forward recovery schedule rewrote finalized pre-activation history");
    }
    coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    if (coordinator.protocolVersion !== PROTOCOL_VERSION + 1 ||
        coordinator.pendingProtocolUpgrade?.version !== PROTOCOL_VERSION + 2) {
      throw new Error("coordinator restart forgot finalized upgrade state");
    }

    const report = {
      activation: { fromVersion: PROTOCOL_VERSION, height: activationHeight,
        toVersion: PROTOCOL_VERSION + 1 },
      finalizedActivationImmutable: true,
      independentValidatorProcesses: children.length,
      oldBinaryActivationError: oldBinaryError,
      preActivationCompatible: oldOnly.height === activationHeight - 1,
      prematureProposalHash,
      prematureRejectionReason,
      prematureProposalRejectedBy: prematureResults.filter(({ rejected }) => rejected).length,
      restartCatchUp: { fromHeight: activationHeight - 2, toHeight: caughtUp.height,
        protocolVersion: caughtUp.protocolVersion },
      rollback: { downgradeRejected: true, historyPrefixPreserved: true,
        mode: "new-quorum-scheduled-forward-upgrade", pendingActivationHeight: recoveryActivationHeight,
        pendingVersion: PROTOCOL_VERSION + 2,
        semanticRollbackExecuted: false,
        note: "Version 26 execution rules are not shipped; current binaries must stop before its activation." },
      status: "passed",
    };
    writeFileSync(join(root, "rehearsal-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return report;
  } finally {
    await Promise.all(children.map(stopValidator));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const [directory, portText = "18791"] = process.argv.slice(2);
  try {
    const report = await runProtocolUpgradeRehearsal({ directory, firstValidatorPort: Number(portText) });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Protocol upgrade rehearsal failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
