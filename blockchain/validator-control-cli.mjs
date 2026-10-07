#!/usr/bin/env node
import { requestValidatorControl } from "./validator-control-socket.mjs";

const [operation, socketPath, ...extra] = process.argv.slice(2);
try {
  if (extra.length !== 0 || !["sync", "produce"].includes(operation) || !socketPath) {
    throw new Error("usage: validator:control <sync|produce> <current-control-socket-path>");
  }
  const response = await requestValidatorControl(socketPath, operation);
  console.log(JSON.stringify(response));
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.error(`Validator control failed: ${error.message}`);
  process.exitCode = 1;
}
