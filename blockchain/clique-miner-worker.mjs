import { parentPort, workerData } from "node:worker_threads";

import { solveCliqueTask } from "./clique-miner.mjs";

// Runs one clique search off the main thread, so an app stays responsive and
// can show progress. The parent stops it by terminating the worker.
const { deadline, networkId, recipient, task } = workerData;
const answer = solveCliqueTask({ networkId, recipient, task,
  onProgress: (progress) => parentPort.postMessage({ progress }),
  shouldStop: () => Date.now() > deadline });
parentPort.postMessage({ answer });
