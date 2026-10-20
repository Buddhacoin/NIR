import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { walletSetupNotice } from "../blockchain/wallet-macos-notices.mjs";

const ADDRESS = `nir1${"a".repeat(64)}`;

test("native setup notices follow the selected language without changing recovery warnings", () => {
  for (const kind of ["recovery-export", "recovery-renewal", "open-failed",
    "incomplete-recovery"]) {
    const options = { address: ADDRESS, unsafePermissions: true };
    const english = walletSetupNotice(kind, "en", options);
    const russian = walletSetupNotice(kind, "ru", options);
    assert.match(english.title, /[A-Za-z]/);
    assert.doesNotMatch(english.message, /[А-Яа-я]/);
    assert.match(russian.message, /[А-Яа-я]/);
    assert.ok(english.message.length > 30);
    assert.ok(russian.message.length > 30);
  }
  assert.match(walletSetupNotice("recovery-renewal", "en").message,
    /old backup and code remain valid/);
  assert.match(walletSetupNotice("recovery-export", "en", { unsafePermissions: true }).message,
    /other users may be able to read/);
  assert.match(walletSetupNotice("incomplete-recovery", "en", { address: ADDRESS }).message,
    /Do not use the address for funds/);
  assert.throws(() => walletSetupNotice("open-failed", "de"), /invalid wallet setup language/);
  assert.throws(() => walletSetupNotice("incomplete-recovery", "en",
    { address: `${ADDRESS}\nForged warning` }), /invalid incomplete-recovery address/);
});

test("native onboarding sends its explicit language to the setup process", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-native-choice-"));
  try {
    const binary = join(directory, "onboarding-choice-smoke");
    const source = new URL("../macos/wallet-onboarding.m", import.meta.url).pathname;
    const built = spawnSync("/usr/bin/clang", ["-fobjc-arc",
      "-DNIR_ONBOARDING_LOCALE_CHOICE_TEST", "-framework", "AppKit",
      "-framework", "Foundation", source, "-o", binary], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { mode: "create", language: "en" });
    const setup = readFileSync(new URL("../blockchain/wallet-macos-setup.mjs", import.meta.url), "utf8");
    assert.match(setup, /choice\.language !== "ru" && choice\.language !== "en"/);
    assert.match(setup, /walletSetupNotice\("recovery-export", currentLanguage/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
