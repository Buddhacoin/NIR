import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { runMacMinerPreflight } from "./miner-macos-preflight.mjs";

const execFileAsync = promisify(execFile);
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/nir-icon.png", ["../wallet-ui/nir-coin-icon.png", "image/png"]],
]);

export async function runPractice(root) {
  const preflight = runMacMinerPreflight({ root, mode: "local-demo", role: "capability-author" });
  if (!preflight.ready) throw new Error("Этот Mac не прошёл проверку локальной тренировки.");
  const { stdout } = await execFileAsync(process.execPath, [join(root, "blockchain/demo.mjs")], {
    cwd: root, env: {}, encoding: "utf8", timeout: 30_000, maxBuffer: 8192,
  });
  const height = /^height: ([0-9]+)$/mu.exec(stdout);
  const tip = /^final block: ([0-9a-f]{64})$/mu.exec(stdout);
  if (!height || !tip || !Number.isSafeInteger(Number(height[1])) ||
      Number(height[1]) < 1 || !/^signature suite: ML-DSA-65$/mu.test(stdout)) {
    throw new Error("Локальная проверка вернула неожиданный результат.");
  }
  return { blockHeight: Number(height[1]), tipHash: tip[1] };
}

export function createMiningPracticeApp({ root, run = runPractice } = {}) {
  if (!root) throw new Error("repository root is required");
  let running = false;
  const server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    };
    function send(code, type, data) {
      response.writeHead(code, { ...headers, "Content-Type": type });
      response.end(data);
    }
    if (request.headers.host !== `127.0.0.1:${server.address().port}`) {
      send(403, "text/plain; charset=utf-8", "Forbidden");
      return;
    }
    let path;
    try { path = new URL(request.url, origin).pathname; }
    catch { send(400, "text/plain; charset=utf-8", "Bad request"); return; }
    if (request.method === "GET" && assets.has(path)) {
      const [name, type] = assets.get(path);
      try {
        const bytes = readFileSync(join(root, "mining-app", name));
        send(200, type, bytes);
      }
      catch { send(500, "text/plain; charset=utf-8", "App asset unavailable"); }
      return;
    }
    if (request.method === "POST" && path === "/practice") {
      if (request.headers.origin !== origin ||
          request.headers["content-length"] !== "0" || request.headers["transfer-encoding"]) {
        send(403, "application/json; charset=utf-8", JSON.stringify({ error: "Request refused" }));
        return;
      }
      if (running) {
        send(409, "application/json; charset=utf-8", JSON.stringify({ error: "Training is already running" }));
        return;
      }
      running = true;
      try {
        const result = await run(root);
        if (!Number.isSafeInteger(result.blockHeight) || result.blockHeight < 1 ||
            !/^[0-9a-f]{64}$/.test(result.tipHash)) {
          throw new Error("invalid local practice result");
        }
        send(200, "application/json; charset=utf-8", JSON.stringify({
          status: "local-practice-complete", scope: "local-valueless-demo-only",
          blockHeight: result.blockHeight, tipHash: result.tipHash,
          walletChanged: false, networkSubmitted: false, rewardCredited: false,
        }));
      } catch {
        send(500, "application/json; charset=utf-8", JSON.stringify({
          error: "Локальная тренировка не завершилась. Баланс кошелька не менялся.",
        }));
      } finally { running = false; }
      return;
    }
    send(404, "text/plain; charset=utf-8", "Not found");
  });
  return server;
}
