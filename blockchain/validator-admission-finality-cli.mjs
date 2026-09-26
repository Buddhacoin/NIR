#!/usr/bin/env node
import { canonicalJson } from "./crypto.mjs";
import {
  loadValidatorAdmissionFinalityEvidence, persistValidatorAdmissionFinalityReceipt,
  verifyValidatorAdmissionFinalityEvidence,
} from "./validator-admission-finality.mjs";

try {
  const [command, evidencePath, outputPath, ...extra] = process.argv.slice(2);
  if (command !== "verify-file" || !evidencePath || !outputPath || extra.length > 0) {
    throw new Error("usage: validator-admission-finality verify-file <canonical-evidence.json> <new-receipt.json>");
  }
  const result = verifyValidatorAdmissionFinalityEvidence(
    loadValidatorAdmissionFinalityEvidence(evidencePath));
  process.stdout.write(`${canonicalJson(persistValidatorAdmissionFinalityReceipt(outputPath, result))}\n`);
} catch (error) {
  process.stderr.write(`Validator admission finality verification failed: ${error.message}\n`);
  process.exitCode = 1;
}
