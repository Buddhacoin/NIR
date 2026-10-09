#!/usr/bin/env node
// Local rehearsal only. The phrase never crosses the browser bridge.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { openPhraseStoreFile } from "./wallet-files.mjs";
import { findLocalPhraseProfile } from "./wallet-onboarding.mjs";

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
    const password = execFileSync("/usr/bin/osascript", ["-e", script, address], {
      encoding: "utf8", maxBuffer: 8 * 1024, timeout: 180_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/\r?\n$/, "");
    const storageRoot = join(homedir(), "Library", "Application Support", "NIR Wallet");
    const profile = findLocalPhraseProfile({ storageRoot, address, password });
    if (!profile) throw new Error("phrase profile unavailable");
    const opened = openPhraseStoreFile({ path: profile.path, password });
    const onboarding = fileURLToPath(new URL("../../../MacOS/onboarding", import.meta.url));
    execFileSync(onboarding, ["--show-secret"], {
      input: JSON.stringify({ kind: "phrase", secret: opened.phrase }),
      encoding: "utf8", maxBuffer: 8 * 1024, timeout: 180_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // Do not print a password, phrase, profile path, or native child stderr.
    process.exitCode = 1;
  }
}
