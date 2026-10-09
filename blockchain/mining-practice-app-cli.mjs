#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

import { runMacMinerPreflight } from "./miner-macos-preflight.mjs";
import { createMiningPracticeApp } from "./mining-practice-app.mjs";

const root = process.cwd();
const report = runMacMinerPreflight({ root, mode: "local-demo", role: "capability-author" });
if (!report.ready) {
  for (const item of report.checks.filter((check) => !check.ok)) console.error(item.message);
  process.exitCode = 2;
} else {
  const server = createMiningPracticeApp({ root });
  server.listen(0, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    console.log(`Открываю локальное приложение: ${url}`);
    console.log("Это только тренировка без реальных наград. Закройте терминал, чтобы остановить приложение.");
    const opener = spawn("/usr/bin/open", [url], { stdio: "ignore" });
    opener.on("error", () => console.error(`Не удалось открыть браузер автоматически. Откройте ${url}`));
  });
}
