#!/usr/bin/env node
import process from "node:process";
import { bootstrapCertificateLifecycle } from "./certificate-bootstrap.mjs";

const [directory, ...urls] = process.argv.slice(2);

try {
  if (!directory || urls.length === 0) {
    throw new Error("usage: certificate-bootstrap <validator-state-dir> <peer-url>...");
  }
  const result = await bootstrapCertificateLifecycle(directory, urls);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`Certificate lifecycle bootstrap failed: ${error.message}`);
  process.exitCode = 1;
}
