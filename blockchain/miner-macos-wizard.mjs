import { MINER_ROLES, runMacMinerPreflight } from "./miner-macos-preflight.mjs";

const ROLE_ENTRIES = Object.freeze(Object.entries(MINER_ROLES));

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
  write("Choose a role:");
  for (const line of roleMenuLines()) write(line);

  let role = null;
  for (let attempt = 0; attempt < maximumAttempts && role === null; attempt += 1) {
    role = parseRoleChoice(await ask(`Role (1-${ROLE_ENTRIES.length}, or role id): `));
    if (role === null) write(`Please enter a number from 1 to ${ROLE_ENTRIES.length}, or an exact role id.`);
  }
  if (role === null) {
    write("No role selected. Nothing was run.");
    return { ready: false, reason: "invalid-role", role: null, nextCommand: null };
  }

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
