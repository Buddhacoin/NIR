#!/usr/bin/env node
import { canonicalJson } from "./crypto.mjs";
import {
  persistValidatorAdmissionFinalityEvidence, persistValidatorAdmissionFinalityReceipt,
} from "./validator-admission-finality.mjs";
import {
  fetchValidatorAdmissionFinalityEvidence, loadValidatorAdmissionProofFetchInput,
} from "./validator-admission-proof-fetch.mjs";

try {
  const [command, inputPath, evidencePath, receiptPath, ...extra] = process.argv.slice(2);
  if (command !== "fetch-file" || !inputPath || !evidencePath || !receiptPath || extra.length > 0) {
    throw new Error("usage: validator-admission-proof-fetch fetch-file <canonical-fetch-input.json> <new-evidence.json> <new-finality-receipt.json>");
  }
  const fetched = await fetchValidatorAdmissionFinalityEvidence({
    input: loadValidatorAdmissionProofFetchInput(inputPath),
  });
  persistValidatorAdmissionFinalityEvidence(evidencePath, fetched.evidence, { idempotent: true });
  const receipt = persistValidatorAdmissionFinalityReceipt(receiptPath, fetched.result,
    { idempotent: true });
  process.stdout.write(`${canonicalJson({ receipt, validSources: fetched.validSources })}\n`);
} catch (error) {
  process.stderr.write(`Validator admission proof fetch failed: ${error.message}\n`);
  process.exitCode = 1;
}
