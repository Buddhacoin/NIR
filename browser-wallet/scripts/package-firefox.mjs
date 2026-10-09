import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "dist-firefox");
const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
if (!manifest.browser_specific_settings?.gecko?.id || manifest.background?.service_worker) {
  throw new Error("Not a Firefox extension build");
}

const artifacts = join(root, "artifacts", "firefox");
mkdirSync(artifacts, { recursive: true });
const archive = join(artifacts, `nir-wallet-firefox-preview-${manifest.version}-unsigned.zip`);
rmSync(archive, { force: true });
execFileSync("zip", ["-X", "-q", "-r", archive, "."], { cwd: source });
const entries = execFileSync("unzip", ["-Z", "-1", archive], { encoding: "utf8" }).trim().split("\n");
for (const required of ["manifest.json", "wallet.html", "app.js", "background.js"]) {
  if (!entries.includes(required)) throw new Error(`Archive is missing ${required}`);
}
console.log(`Firefox submission candidate (unsigned; not directly installable): ${archive}`);
