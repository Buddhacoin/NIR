import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MINER_ROLES = Object.freeze({
  "capability-author": {
    label: "Capability author",
    localDemo: true,
    summary: "Explore a simulated model-improvement claim and reward.",
  },
  "reproduction-operator": {
    label: "Reproduction operator",
    localDemo: false,
    summary: "Requires a future signed job container, assignment, and operator bond.",
  },
  "challenge-author": {
    label: "Challenge author",
    localDemo: false,
    summary: "Requires a future committed challenge registry and independent review.",
  },
  "safety-evaluator": {
    label: "Safety evaluator",
    localDemo: false,
    summary: "Requires a future approved suite and containment profile.",
  },
  "safety-investigator": {
    label: "Safety investigator",
    localDemo: false,
    summary: "Requires a future private commit and assigned reproduction committee.",
  },
  "fraud-challenger": {
    label: "Fraud challenger",
    localDemo: false,
    summary: "Requires a future live consensus violation and objective evidence.",
  },
  "payment-node": {
    label: "Payment node",
    localDemo: true,
    summary: "A loopback-only, valueless development node can run locally.",
  },
});

const REQUIRED_FILES = Object.freeze([
  "package.json",
  "blockchain/demo.mjs",
  "blockchain/node-cli.mjs",
  "blockchain/wallet-cli.mjs",
  "wallet-ui/index.html",
]);

function check(id, ok, pass, fail) {
  return { id, ok, message: ok ? pass : fail };
}

function isPlainFile(path) {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

export function runMacMinerPreflight({
  root,
  mode = "local-demo",
  role = "capability-author",
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
} = {}) {
  if (!root) throw new Error("repository root is required");
  if (!Object.hasOwn(MINER_ROLES, role)) {
    throw new Error(`unknown role: ${role}`);
  }

  const major = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  let packageIsNir = false;
  try {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    packageIsNir = packageJson.name === "nir-protocol" && packageJson.private === true;
  } catch {}

  const checks = [
    check("mode", mode === "local-demo",
      "Local, valueless demonstration selected.",
      "Public testnet mining is unavailable: no official manifest, peers, faucet, or job queue is published."),
    check("macos", platform === "darwin", "macOS detected.", "This guide and preflight require macOS."),
    check("architecture", ["arm64", "x64"].includes(arch),
      `Supported Mac architecture detected (${arch}).`, `Unsupported Mac architecture: ${arch}.`),
    check("node", Number.isInteger(major) && major >= 26,
      `Node.js ${nodeVersion} satisfies the repository requirement (26+).`,
      `Node.js 26+ is required; found ${nodeVersion || "no version"}.`),
    check("repository", packageIsNir,
      "NIR source checkout recognized.", "Run this command from the root of a trusted NIR source checkout."),
    check("files", REQUIRED_FILES.every((path) => isPlainFile(join(root, path))),
      "Local demo, node, wallet, and UI entrypoints are present.",
      "One or more required source files are missing or are not regular files."),
    check("role", MINER_ROLES[role].localDemo,
      `${MINER_ROLES[role].label} has a local demonstration path.`,
      `${MINER_ROLES[role].label} is specification-only today; there is no honest local onboarding flow for it.`),
  ];

  const ready = checks.every((item) => item.ok);
  return {
    format: "nir-macos-miner-preflight-v1",
    ready,
    scope: "local-valueless-demo-only",
    mode,
    role,
    roleSummary: MINER_ROLES[role].summary,
    checks,
    nextCommand: ready
      ? role === "payment-node" ? "npm run node:init-dev -- .nir-local-node"
        : "npm run mine:demo"
      : null,
    warnings: [
      "This does not connect to a public NIR network.",
      "Displayed demo rewards are simulated and have no monetary value.",
      "Do not enter wallet secrets into websites, chat, command arguments, or environment variables.",
    ],
  };
}
