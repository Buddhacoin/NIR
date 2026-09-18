#!/usr/bin/env node
import { chmodSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { parseConsensusJson } from "./consensus-json.mjs";
import { canonicalJson } from "./crypto.mjs";
import {
  compileGenesis,
  createGenesisApprovalEnvelope,
  createGenesisPlan,
  signGenesisPlan,
  signGenesisPeerRegistry,
  verifyGenesisCeremony,
} from "./genesis-ceremony.mjs";
import {
  assembleCeremonyRegistryAnchor,
  createCeremonyRegistryAnchorPayload,
  signCeremonyRegistryAnchor,
} from "./genesis-ceremony-anchor.mjs";
import {
  appendCeremonyRegistry,
  repairCeremonyRegistryOneCopy,
  verifyCeremonyRegistry,
} from "./genesis-ceremony-store.mjs";
import { decryptWallet } from "./vault.mjs";

function readJson(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 * 1024) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  return parseConsensusJson(readFileSync(path, "utf8"));
}

function writeExclusive(path, value) {
  writeFileSync(path, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(path, 0o644);
}

function priorPlans(path) {
  if (path === undefined) return [];
  const value = readJson(path, "prior plans");
  if (!Array.isArray(value)) throw new Error("prior plans file must contain an array");
  return value;
}

function readSecret(prompt) {
  return new Promise((resolveSecret, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      reject(new Error("secure password entry requires an interactive terminal")); return;
    }
    process.stdout.write(prompt);
    let value = "";
    const finish = (error) => {
      process.stdin.off("data", onData); process.stdin.setRawMode(false);
      process.stdin.pause(); process.stdout.write("\n");
      error ? reject(error) : resolveSecret(value);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", onData);
  });
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "plan" && args.length === 4) {
    const [inputPath, releasePath, trustedAddress, outputPath] = args;
    const plan = createGenesisPlan(readJson(inputPath, "genesis ceremony input"), {
      signedRelease: readJson(releasePath, "signed source release"), trustedAddress,
    });
    writeExclusive(outputPath, plan);
    console.log(`Valueless developer testnet plan ${plan.commitment} created.`);
  } else if (command === "sign" && args.length === 5) {
    const [planPath, releasePath, trustedAddress, vaultPath, outputPath] = args;
    const password = await readSecret("Ceremony operator vault password: ");
    const wallet = decryptWallet(readJson(vaultPath, "operator vault"), password);
    try {
      writeExclusive(outputPath, signGenesisPlan(readJson(planPath, "genesis plan"), wallet, {
        signedRelease: readJson(releasePath, "signed source release"), trustedAddress,
      }));
      console.log(`Genesis commitment signed offline by ${wallet.address}.`);
    } finally { wallet.privateKey = ""; }
  } else if (command === "sign-peer-registry" && args.length === 5) {
    const [planPath, releasePath, trustedAddress, vaultPath, outputPath] = args;
    const password = await readSecret("Genesis validator vault password: ");
    const wallet = decryptWallet(readJson(vaultPath, "validator vault"), password);
    try {
      writeExclusive(
        outputPath, signGenesisPeerRegistry(readJson(planPath, "genesis plan"), wallet, {
          signedRelease: readJson(releasePath, "signed source release"), trustedAddress,
        }),
      );
      console.log(`Genesis peer registry signed offline by ${wallet.address}.`);
    } finally { wallet.privateKey = ""; }
  } else if (command === "assemble" && args.length === 5) {
    const [planPath, releasePath, trustedAddress, approvalsPath, outputPath] = args;
    const approvals = readJson(approvalsPath, "genesis approvals");
    if (!approvals || !Array.isArray(approvals.approvals) ||
        !Array.isArray(approvals.peerRegistryApprovals)) {
      throw new Error("genesis approvals file must contain both approval arrays");
    }
    const envelope = createGenesisApprovalEnvelope(
      readJson(planPath, "genesis plan"), approvals.approvals, approvals.peerRegistryApprovals, {
        signedRelease: readJson(releasePath, "signed source release"), trustedAddress,
      },
    );
    writeExclusive(outputPath, envelope);
    console.log(`Approval envelope for ${envelope.commitment} assembled.`);
  } else if (command === "verify" && (args.length === 4 || args.length === 5)) {
    const [planPath, envelopePath, releasePath, trustedAddress, priorPath] = args;
    const result = verifyGenesisCeremony(
      readJson(planPath, "genesis plan"), readJson(envelopePath, "approval envelope"),
      {
        priorPlans: priorPlans(priorPath),
        signedRelease: readJson(releasePath, "signed source release"),
        trustedAddress,
      },
    );
    console.log(`${JSON.stringify(result)}\nValueless developer testnet ceremony verified.`);
  } else if (command === "compile" && (args.length === 5 || args.length === 6)) {
    const [planPath, envelopePath, releasePath, trustedAddress, outputPath, priorPath] = args;
    const result = compileGenesis(
      readJson(planPath, "genesis plan"), readJson(envelopePath, "approval envelope"),
      {
        priorPlans: priorPlans(priorPath),
        signedRelease: readJson(releasePath, "signed source release"),
        trustedAddress,
      },
    );
    writeExclusive(outputPath, result.genesis);
    console.log(`Genesis ${result.genesisHash} compiled for valueless developer testnet only.`);
  } else if (command === "registry-append" && (args.length === 5 || args.length === 6)) {
    const [directory, planPath, envelopePath, releasePath, trustedAddress, anchorPath] = args;
    const result = appendCeremonyRegistry(
      directory, readJson(planPath, "genesis plan"),
      readJson(envelopePath, "approval envelope"), {
        anchor: anchorPath === undefined ? null : readJson(anchorPath, "registry anchor"),
        signedRelease: readJson(releasePath, "signed source release"), trustedAddress,
      },
    );
    console.log(JSON.stringify(result));
  } else if (command === "registry-verify" && (args.length === 2 || args.length === 3)) {
    const result = verifyCeremonyRegistry(args[0], {
      anchor: args[2] === undefined ? null : readJson(args[2], "registry anchor"),
      trustedAddress: args[1],
    });
    console.log(JSON.stringify({ count: result.count, head: result.head, verified: true }));
  } else if (command === "registry-repair-one-copy" &&
      (args.length === 2 || args.length === 3)) {
    console.log(JSON.stringify(repairCeremonyRegistryOneCopy(
      args[0], {
        anchor: args[2] === undefined ? null : readJson(args[2], "registry anchor"),
        trustedAddress: args[1],
      },
    )));
  } else if (command === "export-anchor-payload" && args.length === 3) {
    const [directory, trustedAddress, outputPath] = args;
    const payload = createCeremonyRegistryAnchorPayload(
      verifyCeremonyRegistry(directory, { trustedAddress }),
    );
    writeExclusive(outputPath, payload);
    console.log(`Ceremony registry anchor payload ${payload.registryHead} exported.`);
  } else if (command === "sign-anchor" && args.length === 6) {
    const [payloadPath, planPath, releasePath, trustedAddress, vaultPath, outputPath] = args;
    const password = await readSecret("Latest ceremony operator vault password: ");
    const wallet = decryptWallet(readJson(vaultPath, "ceremony operator vault"), password);
    try {
      writeExclusive(outputPath, signCeremonyRegistryAnchor(
        readJson(payloadPath, "anchor payload"), readJson(planPath, "genesis plan"), wallet, {
          signedRelease: readJson(releasePath, "signed source release"), trustedAddress,
        },
      ));
      console.log(`Ceremony registry anchor signed offline by ${wallet.address}.`);
    } finally { wallet.privateKey = ""; }
  } else if (command === "assemble-anchor" && args.length === 6) {
    const [payloadPath, planPath, releasePath, trustedAddress, approvalsPath, outputPath] = args;
    const anchor = assembleCeremonyRegistryAnchor(
      readJson(payloadPath, "anchor payload"), readJson(planPath, "genesis plan"),
      readJson(approvalsPath, "anchor approvals"), {
        signedRelease: readJson(releasePath, "signed source release"), trustedAddress,
      },
    );
    writeExclusive(outputPath, anchor);
    console.log(`Ceremony registry anchor ${anchor.payload.registryHead} assembled.`);
  } else if (command === "verify-with-anchor" && args.length === 3) {
    const [directory, trustedAddress, anchorPath] = args;
    const result = verifyCeremonyRegistry(directory, {
      anchor: readJson(anchorPath, "registry anchor"), trustedAddress,
    });
    console.log(JSON.stringify({ count: result.count, head: result.head, verified: true }));
  } else {
    throw new Error("usage: genesis:ceremony <plan ... | sign ... | sign-peer-registry ... | assemble ... | verify ... | compile ... | registry-append registry-dir plan.json envelope.json signed-release.json trusted-address [anchor.json] | registry-verify registry-dir trusted-address [anchor.json] | registry-repair-one-copy registry-dir trusted-address [anchor.json] | export-anchor-payload registry-dir trusted-address payload.json | sign-anchor payload.json plan.json signed-release.json trusted-address operator-vault.json approval.json | assemble-anchor payload.json plan.json signed-release.json trusted-address approvals.json anchor.json | verify-with-anchor registry-dir trusted-address anchor.json>");
  }
} catch (error) {
  console.error(`Genesis ceremony failed: ${error.message}`);
  process.exitCode = 1;
}
