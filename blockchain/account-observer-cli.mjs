#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import process from "node:process";

import {
  createLaunchedAccountObserver, loadAccountObserverLaunchConfig,
  parseObserverLaunchArguments,
} from "./account-observer-launcher.mjs";

let server;
try {
  // A bearer token must not enter argv, environment, a redirected output stream
  // or a log file. The operator manually copies this one-session token to Firefox.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("observer launch requires an interactive terminal; token output cannot be redirected");
  }
  const config = loadAccountObserverLaunchConfig(
    parseObserverLaunchArguments(process.argv.slice(2)));
  process.stdout.write(`Firefox origin: ${config.origin}\nAccount: ${config.address}\n` +
    `Network: ${config.trustAnchor.expectedNetworkId}\n` +
    `Pinned genesis: ${config.trustAnchor.genesisCheckpoint.tipHash}\n` +
    `Local node: ${config.nodeBaseUrl}\nCheckpoint: ${config.checkpointPath}\n` +
    "Only continue if these values match your independently reviewed network and extension. Type START: ");
  const answer = await new Promise((resolve) => {
    process.stdin.once("data", (value) => resolve(value.toString("utf8").trim()));
  });
  if (answer !== "START") throw new Error("observer launch cancelled");
  const token = randomBytes(32).toString("hex");
  server = createLaunchedAccountObserver(config, token);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", resolve);
  });
  process.stdout.write(`Local observer URL: http://127.0.0.1:${config.port}/\n` +
    `One-session observer token (copy into Firefox, do not share): ${token}\n` +
    "Close this terminal after use. The token is not a wallet key and cannot authorize signing.\n");
  const close = () => server.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} catch (error) {
  if (server) server.close();
  process.stderr.write(`Observer not started: ${error.message}\n`);
  process.exitCode = 1;
}
