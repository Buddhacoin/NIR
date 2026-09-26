#!/usr/bin/env node
import process from "node:process";

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      reject(new Error("secure password entry requires an interactive terminal")); return;
    }
    process.stdout.write(prompt); let value = "";
    const finish = (error) => {
      process.stdin.off("data", onData); process.stdin.setRawMode(false); process.stdin.pause();
      process.stdout.write("\n"); error ? reject(error) : resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") { value += character; if (Buffer.byteLength(value) > 1024) return finish(new Error("secret input is too long")); }
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", onData);
  });
}
async function twoPasswords() {
  const consensusPassword = await readSecret("Consensus identity password: ");
  const transportPassword = await readSecret("Transport identity password: ");
  return { consensusPassword, transportPassword };
}
async function newPasswords() {
  const consensusPassword = await readSecret("New consensus identity password: ");
  if (consensusPassword !== await readSecret("Repeat consensus identity password: ")) throw new Error("consensus passwords do not match");
  const transportPassword = await readSecret("New transport identity password: ");
  if (transportPassword !== await readSecret("Repeat transport identity password: ")) throw new Error("transport passwords do not match");
  return { consensusPassword, transportPassword };
}

const [command, ...args] = process.argv.slice(2);
try {
  let result;
  if (command === "submit-admission" && args.length === 3) {
    const submission = await import("./validator-admission-submission.mjs");
    result = await submission.submitValidatorAdmission({ directory: args[0],
      signedArtifactPath: args[1],
      submissionInput: submission.loadValidatorAdmissionSubmissionInput(args[2]) });
  } else {
    const join = await import("./validator-join.mjs");
  if (command === "init" && args.length === 2) {
    const inputs = join.loadValidatorJoinInputs(args[1]);
    result = join.createValidatorJoinWorkspace({ directory: args[0], ...inputs, ...await newPasswords() });
  } else if (command === "status" && args.length === 1) {
    result = join.validatorJoinStatus(args[0]);
  } else if (command === "verify" && args.length === 1) {
    result = join.verifyValidatorJoinWorkspace({ directory: args[0], ...await twoPasswords() });
  } else if (command === "backup" && args.length === 3) {
    result = join.createValidatorJoinBackups({ directory: args[0], backupDirectory: args[1],
      generation: Number(args[2]), ...await twoPasswords() });
  } else if (command === "sync" && args.length === 2) {
    result = await join.syncValidatorJoinCandidateContext({ directory: args[0],
      syncInput: join.loadValidatorCandidateSyncInput(args[1]) });
  } else if (command === "prepare-admission" && args.length === 2) {
    result = join.prepareValidatorAdmissionSigningPackage({ directory: args[0], outputPath: args[1] });
  } else if (command === "sign-admission" && args.length === 3) {
    const { readCeremonyPasswordBuffers } = await import("./operator-secret-input.mjs");
    const passwords = await readCeremonyPasswordBuffers();
    let consensusPassword; let transportPassword;
    try {
      consensusPassword = passwords.validatorPasswordBuffer.toString("utf8");
      transportPassword = passwords.transportPasswordBuffer.toString("utf8");
      result = join.signValidatorAdmissionPackage({ directory: args[0], packagePath: args[1],
        outputPath: args[2], consensusPassword, transportPassword });
    } finally {
      passwords.validatorPasswordBuffer.fill(0); passwords.transportPasswordBuffer.fill(0);
      consensusPassword = ""; transportPassword = "";
    }
  } else if (command === "resolve-expired-admission" && args.length === 1) {
    result = join.resolveExpiredValidatorAdmissionIntent({ directory: args[0] });
  } else {
    throw new Error("usage: validator:join init <new-workspace> <private-config.json> | validator:join status <workspace> | validator:join verify <workspace> | validator:join backup <workspace> <new-private-backup-directory> <generation> | validator:join sync <workspace> <public-sync-input.json> | validator:join prepare-admission <workspace> <new-package.json> | validator:join sign-admission <workspace> <package.json> <new-signed-transaction.json> | validator:join resolve-expired-admission <workspace> | validator:join submit-admission <workspace> <signed-artifact.json> <fresh-sync-input.json>");
  }
  }
  console.log(JSON.stringify(result, null, 2));
  if (command === "sync") {
    console.error("Status: proof-backed read-only v31 candidate context synchronized.");
    console.error("Admission, readiness observation, selection, and activation are not implemented by this command.");
  } else if (command === "prepare-admission") {
    console.error("Status: canonical protocol-v32 admission package prepared; nothing was signed or broadcast.");
  } else if (command === "sign-admission") {
    console.error("Status: admission signed offline and journaled as unresolved; nothing was broadcast.");
  } else if (command === "resolve-expired-admission") {
    console.error("Status: expired unsubmitted intent resolved from a newer proof-backed context.");
  } else if (command === "submit-admission") {
    console.error(`Status: ${result.status}.`);
    console.error("Submission quorum is not a finalized inclusion proof.");
  } else if (command === "status") {
    console.error(`Status: ${result.status}.`);
  } else {
    console.error("Status: secure local validator workspace operation completed.");
    console.error("A proof-backed v31 candidate context must be synchronized separately.");
  }
  console.error(command === "submit-admission" ? "No finality, readiness, selection, or activation is claimed." :
    command === "sign-admission" ? "No transaction was broadcast." :
      "No transaction was signed or broadcast.");
} catch (error) {
  console.error(`Validator join operation failed: ${error.message}`); process.exitCode = 1;
}
