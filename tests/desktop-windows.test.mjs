import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readPlainPrivateJson, replacePlainPrivateJson, writePlainPrivateJsonExclusive }
  from "../blockchain/wallet-files-windows.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Windows wallet files appear whole, never replace another and are read only as single plain files", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-plain-files-"));
  try {
    const path = join(directory, "wallet.nirvault.json");
    writePlainPrivateJsonExclusive(path, { format: "first" });
    assert.deepEqual(readPlainPrivateJson(path, 1024), { format: "first" });
    assert.equal(lstatSync(path).nlink, 1);
    assert.throws(() => writePlainPrivateJsonExclusive(path, { format: "second" }), /EEXIST/);
    assert.deepEqual(readPlainPrivateJson(path, 1024), { format: "first" });
    // No temporary generation is left behind.
    assert.deepEqual(readdirSync(directory), ["wallet.nirvault.json"]);

    replacePlainPrivateJson(path, { format: "replaced" }, { maxBytes: 1024,
      check: (staged) => assert.equal(staged.format, "replaced") });
    assert.deepEqual(readPlainPrivateJson(path, 1024), { format: "replaced" });
    // A failing check keeps the old file and leaves no generation.
    assert.throws(() => replacePlainPrivateJson(path, { format: "bad" }, { maxBytes: 1024,
      check: () => { throw new Error("check failed"); } }), /check failed/);
    assert.deepEqual(readPlainPrivateJson(path, 1024), { format: "replaced" });
    assert.deepEqual(readdirSync(directory), ["wallet.nirvault.json"]);

    // A link to the file, a symbolic link or an oversized file is refused.
    const extra = join(directory, "extra.json");
    linkSync(path, extra);
    assert.throws(() => readPlainPrivateJson(path, 1024), /unsafe/);
    rmSync(extra);
    const pointer = join(directory, "pointer.json");
    symlinkSync(path, pointer);
    assert.throws(() => readPlainPrivateJson(pointer, 1024), /not a regular file/);
    const big = join(directory, "big.json");
    writeFileSync(big, JSON.stringify({ data: "x".repeat(2000) }));
    assert.throws(() => readPlainPrivateJson(big, 1024), /unsafe/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// Runs the whole desktop wallet as Windows would: plain files, no POSIX
// modes, no activation links.
const WINDOWS_FLOW = `
import assert from "node:assert/strict";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDesktopWalletHost } from "./blockchain/desktop-wallet.mjs";
import { listLocalTestWallets } from "./blockchain/wallet-onboarding.mjs";
import { verifyWalletFile, walletPublicInfo } from "./blockchain/wallet-files.mjs";
assert.equal(process.platform, "win32");
const storageRoot = process.argv[1];
const password = "Zeus-Olymp-2026";
let words;
const steps = [
  () => ({ button: "create", values: {} }),
  () => ({ button: "next", values: { password, repeat: password } }),
  (spec) => { words = [...spec.words]; return { button: "written", values: {} }; },
  (spec) => { const [a, b] = spec.fields.map((f) => Number(f.label.match(/\\d+/)[0]) - 1);
    return { button: "check", values: { a: words[a], b: words[b] } }; },
];
const host = createDesktopWalletHost({ storageRoot, language: "en", dialogs: { ask: async (spec) => steps.shift()?.(spec) ?? null } });
const selected = await host.setup();
assert.equal(words.length, 24);
assert.equal(walletPublicInfo(selected.walletPath).address, selected.address);
for (const name of readdirSync(join(storageRoot, "Wallets"))) {
  assert.equal(lstatSync(join(storageRoot, "Wallets", name)).isSymbolicLink(), false);
}
assert.equal(readdirSync(join(storageRoot, "Wallets")).length, 1);
assert.equal(listLocalTestWallets(storageRoot)[0].address, selected.address);
const fresh = "Hera-Argos-2027";
const change = [() => ({ button: "change", values: { current: password, fresh, repeat: fresh } })];
assert.equal(await createDesktopWalletHost({ storageRoot, dialogs: { ask: async (spec) => change.shift()?.(spec) ?? null } })
  .passwordChange({ vaultPath: selected.walletPath }), true);
assert.equal(verifyWalletFile({ path: selected.walletPath, password: fresh }).address, selected.address);
assert.throws(() => verifyWalletFile({ path: selected.walletPath, password }));
assert.deepEqual(readdirSync(join(storageRoot, "Wallets")).length, 1);
const added = [() => ({ button: "create", values: { password: fresh } })];
const second = await createDesktopWalletHost({ storageRoot, dialogs: { ask: async (spec) => added.shift()?.(spec) ?? null } }).createAccount();
assert.notEqual(second.address, selected.address);
assert.equal(listLocalTestWallets(storageRoot).length, 2);
process.stdout.write("windows-flow-ok");
`;

test("the desktop wallet runs end to end with Windows file handling", () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "nir-windows-wallet-"));
  try {
    const result = spawnSync(process.execPath, [
      "--import", 'data:text/javascript,Object.defineProperty(process,"platform",{value:"win32"})',
      "--input-type=module", "-e", WINDOWS_FLOW, storageRoot,
    ], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 120_000 });
    assert.equal(result.stdout, "windows-flow-ok", result.stderr);
  } finally { rmSync(storageRoot, { recursive: true, force: true }); }
});

test("checkouts on Windows keep the committed bytes of hashed files such as the word list", () => {
  assert.match(read(".gitattributes"), /^\* text=auto eol=lf$/m);
  assert.doesNotMatch(read("blockchain/bip39-english.txt"), /\r/);
});

test("the Windows installer verifies Node.js, needs no git or administrator and makes a NIR shortcut", () => {
  const installer = read("site/install.ps1");
  assert.match(installer, /\$NodeVersion = "([0-9.]+)"/);
  assert.equal(/\$NodeVersion = "([0-9.]+)"/.exec(installer)[1], /NODE_VERSION="([0-9.]+)"/.exec(read("site/install.sh"))[1]);
  assert.match(installer, /Get-FileHash -Algorithm SHA256/);
  assert.match(installer, /SHASUMS256\.txt/);
  assert.match(installer, /archive\/refs\/heads\/main\.zip/);
  assert.match(installer, /blockchain\\nir-desktop\.mjs/);
  assert.match(installer, /-EncodedCommand/);
  assert.match(installer, /desktop-ui\\nir\.ico/);
  assert.doesNotMatch(installer, /RunAs|Set-ExecutionPolicy|git clone/);
  assert.ok(readFileSync(new URL("../desktop-ui/nir.ico", import.meta.url)).subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])));
  // The website shows the command, and the server serves the script as UTF-8 text for irm.
  assert.match(read("site/index.html"), /irm https:\/\/nircoin\.com\/install\.ps1 \| iex/);
  assert.match(read("deploy/install-shared-testnet.sh"), /header \/install\.ps1 Content-Type "text\/plain; charset=utf-8"/);
});
