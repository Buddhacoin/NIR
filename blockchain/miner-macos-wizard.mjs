import { accessSync, constants, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { MINER_ROLES, runMacMinerPreflight } from "./miner-macos-preflight.mjs";

const ROLE_ENTRIES = Object.freeze(Object.entries(MINER_ROLES));
const ADAPTER_CHOICE = "adapter-check";

export function roleMenuLines() {
  return ROLE_ENTRIES.map(([id, role], index) =>
    `${index + 1}. ${role.label} — ${role.localDemo ? "local demo available" : "planned only"} [${id}]`);
}

export function parseRoleChoice(value) {
  const choice = String(value).trim();
  const number = Number(choice);
  if (Number.isSafeInteger(number) && number >= 1 && number <= ROLE_ENTRIES.length) {
    return ROLE_ENTRIES[number - 1][0];
  }
  return Object.hasOwn(MINER_ROLES, choice) ? choice : null;
}

function parseWizardChoice(value) {
  const choice = String(value).trim();
  if (choice === String(ROLE_ENTRIES.length + 1) || choice === ADAPTER_CHOICE) {
    return ADAPTER_CHOICE;
  }
  return parseRoleChoice(choice);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function adapterCheckCommand(path) {
  const exactPath = String(path).trim();
  if (!isAbsolute(exactPath)) throw new Error("adapter path must be absolute");
  let metadata;
  try {
    metadata = lstatSync(exactPath);
    accessSync(exactPath, constants.X_OK);
  } catch {
    throw new Error("adapter path must be an existing executable file");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("adapter path must be a regular file, not a link");
  }
  return `npm run mine:adapter-check -- -- ${shellQuote(exactPath)}`;
}

function adapterCheckerExists(root) {
  try {
    return ["nir/application_adapter.py", "nir/adapter_check.py"]
      .every((path) => lstatSync(join(root, path)).isFile());
  } catch {
    return false;
  }
}

async function adapterPath({ root, ask, write, platform, arch, nodeVersion }) {
  write("Developer adapter check selected.");
  write("This checks only the local transport handshake. It is not a sandbox or an intelligence/mining test.");
  const report = runMacMinerPreflight({
    root, role: "capability-author", mode: "local-demo", platform, arch, nodeVersion,
  });
  const checkerPresent = adapterCheckerExists(root);
  for (const item of report.checks) write(`${item.ok ? "PASS" : "FAIL"} ${item.message}`);
  write(`${checkerPresent ? "PASS" : "FAIL"} Local adapter transport and checker are present.`);
  if (!report.ready || !checkerPresent) {
    write("No runnable adapter-check command is available. Nothing was run.");
    return { ready: false, reason: "adapter-check-unavailable", role: null, nextCommand: null };
  }
  write("Enter only an absolute path to an adapter executable; never enter a password, token, key, or seed.");
  let nextCommand = null;
  try {
    nextCommand = adapterCheckCommand(await ask("Adapter executable path: "));
  } catch (error) {
    write(`FAIL ${error.message}`);
  }
  if (nextCommand === null) {
    write("No runnable adapter-check command is available. Nothing was run.");
    return { ready: false, reason: "invalid-adapter-path", role: null, nextCommand: null };
  }
  write("WARNING Running the printed command will start that adapter without an OS sandbox.");
  write("Review the path, then run this command yourself only if you trust the adapter:");
  write(nextCommand);
  write("The wizard did not run this command.");
  return { ready: true, reason: "adapter-check", role: null, nextCommand };
}

export async function runMacMinerWizard({
  root,
  ask,
  write,
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  maximumAttempts = 3,
} = {}) {
  if (typeof ask !== "function" || typeof write !== "function") {
    throw new Error("wizard input and output functions are required");
  }
  write("NIR Mac setup — local, valueless practice only.");
  write("This wizard never starts a command, connects to a public network, or asks for secrets.");
  write("Choose a local role, or the separate developer adapter check:");
  for (const line of roleMenuLines()) write(line);
  write(`${ROLE_ENTRIES.length + 1}. Developer adapter transport check — not mining [${ADAPTER_CHOICE}]`);

  let choice = null;
  for (let attempt = 0; attempt < maximumAttempts && choice === null; attempt += 1) {
    choice = parseWizardChoice(await ask(`Choice (1-${ROLE_ENTRIES.length + 1}, or id): `));
    if (choice === null) write(`Please enter a number from 1 to ${ROLE_ENTRIES.length + 1}, or an exact id.`);
  }
  if (choice === null) {
    write("No role selected. Nothing was run.");
    return { ready: false, reason: "invalid-role", role: null, nextCommand: null };
  }
  if (choice === ADAPTER_CHOICE) {
    return adapterPath({ root, ask, write, platform, arch, nodeVersion });
  }
  const role = choice;

  write(`Checking this Mac for: ${MINER_ROLES[role].label}`);
  const report = runMacMinerPreflight({
    root, role, mode: "local-demo", platform, arch, nodeVersion,
  });
  for (const item of report.checks) write(`${item.ok ? "PASS" : "FAIL"} ${item.message}`);
  for (const warning of report.warnings) write(`WARNING ${warning}`);

  const nextCommand = report.ready ? report.nextCommand : null;
  if (nextCommand === null) {
    write("No runnable next command is available for this selection. Nothing was run.");
    return { ...report, ready: false, nextCommand: null };
  }
  write("Ready. Review the command below, then run it yourself only if you want to continue:");
  write(nextCommand);
  write("The wizard did not run this command.");
  return { ...report, nextCommand };
}
