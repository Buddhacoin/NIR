#!/usr/bin/env node
import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import { createMiningPracticeApp, miningModelAppPreflight } from "./mining-practice-app.mjs";

const embedded = process.argv.length === 3 && process.argv[2] === "--embedded";
if (process.argv.length !== (embedded ? 3 : 2)) {
  console.error("usage: mining-practice-app-cli.mjs [--embedded]");
  process.exit(2);
}
const root = process.cwd();
const execFileAsync = promisify(execFile);
const report = miningModelAppPreflight({ root });
if (!report.ready) {
  for (const [ok, message] of report.checks) if (!ok) console.error(message);
  process.exitCode = 2;
} else {
  try {
    const { stdout } = await execFileAsync(process.env.NIR_MINING_PYTHON ?? "python3", ["-m", "nir.iris_rehearsal", "--check"], {
      cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      encoding: "utf8", timeout: 5_000, maxBuffer: 2048,
    });
    if (JSON.parse(stdout).status !== "pinned-iris-ready") throw new Error("invalid model preflight");
    const server = createMiningPracticeApp({ root });
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/${embedded ? "?local-app=1" : ""}`;
      if (embedded) {
        console.log(`NIR_MODEL_LAB_URL=${url}`);
        console.log(`NIR_MODEL_LAB_SESSION=${server.localSessionToken}`);
        return;
      }
      console.log(`Откройте этот локальный адрес вручную в браузере: ${url}#session=${server.localSessionToken}`);
      console.log("Iris доступна локально; Qwen требует отдельного согласия и дополнительных библиотек. Это не публичный майнинг и не начисляет NIR. Закройте терминал, чтобы остановить приложение.");
    });
  } catch {
    console.error("Для локальной проверки нужна Python 3.11+ и неизменённые встроенные Iris-файлы из доверенной копии NIR. Проверьте `python3 --version` и переустановите исходный код; приложение не запускалось.");
    process.exitCode = 2;
  }
}
