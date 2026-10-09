#!/usr/bin/env node
// Local rehearsal only. The phrase never crosses the browser bridge.
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { openPhraseStoreFile } from "./wallet-files.mjs";
import { findLocalPhraseProfile } from "./wallet-onboarding.mjs";

const execFileAsync = promisify(execFile);
const controller = new AbortController();
for (const event of ["SIGINT", "SIGTERM"]) {
  process.once(event, () => controller.abort());
}

function showNativePhrase(executable, phrase) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--show-secret"], {
      signal: controller.signal, stdio: ["pipe", "ignore", "ignore"],
      timeout: 180_000,
    });
    child.once("error", reject);
    child.once("close", (status) => {
      if (status === 0 && !controller.signal.aborted) resolve();
      else reject(new Error("native phrase display ended"));
    });
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify({ kind: "phrase", secret: phrase }));
  });
}

const address = process.argv[2];
if (process.platform !== "darwin" || process.argv.length !== 3 ||
    !/^nir1[0-9a-f]{64}$/.test(address ?? "")) {
  process.exitCode = 1;
} else {
  try {
    const script = `on run argv
 set answer to display dialog "Показать фразу восстановления NIR для адреса " & (item 1 of argv) & "? Введите локальный пароль. Никому не показывайте фразу." default answer "" with hidden answer buttons {"Отмена", "Показать"} default button "Отмена" with icon caution
 return text returned of answer
end run`;
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script, address], {
      encoding: "utf8", maxBuffer: 8 * 1024, timeout: 180_000,
      signal: controller.signal,
    });
    const password = stdout.replace(/\r?\n$/, "");
    if (controller.signal.aborted) throw new Error("phrase display was cancelled");
    const storageRoot = join(homedir(), "Library", "Application Support", "NIR Wallet");
    const profile = findLocalPhraseProfile({ storageRoot, address, password });
    if (!profile) throw new Error("phrase profile unavailable");
    const opened = openPhraseStoreFile({ path: profile.path, password });
    if (controller.signal.aborted) throw new Error("phrase display was cancelled");
    const onboarding = fileURLToPath(new URL("../../../MacOS/onboarding", import.meta.url));
    await showNativePhrase(onboarding, opened.phrase);
  } catch {
    // Do not print a password, phrase, profile path, or native child stderr.
    process.exitCode = 1;
  }
}
