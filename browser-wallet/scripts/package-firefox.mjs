import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeDeterministicZip } from "./deterministic-zip.mjs";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "dist-firefox");
const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
if (!manifest.browser_specific_settings?.gecko?.id || manifest.background?.service_worker) {
  throw new Error("Not a Firefox extension build");
}
const repository = resolve(root, "..");
const changed = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal", "--", "browser-wallet", "blockchain/bip39-english.txt", "wallet-ui/nir-coin-icon.png"], { cwd: repository, encoding: "utf8" });
if (changed.trim()) throw new Error("Refusing to attest a package built from uncommitted source changes");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();

const artifacts = join(root, "artifacts", "firefox");
mkdirSync(artifacts, { recursive: true });
const archive = join(artifacts, `nir-wallet-firefox-preview-${manifest.version}-unsigned.zip`);
rmSync(archive, { force: true });
const files = writeDeterministicZip(source, archive);
const entries = execFileSync("unzip", ["-Z", "-1", archive], { encoding: "utf8" }).trim().split("\n");
for (const required of ["manifest.json", "wallet.html", "app.js", "background.js"]) {
  if (!entries.includes(required)) throw new Error(`Archive is missing ${required}`);
}
if (files.join("\n") !== entries.join("\n")) throw new Error("ZIP file list differs from build output");
const sourceArchive = join(artifacts, `nir-wallet-firefox-source-${revision.slice(0, 12)}.zip`);
execFileSync("git", ["archive", "--format=zip", `--output=${sourceArchive}`, "HEAD", "browser-wallet", "blockchain/bip39-english.txt", "wallet-ui/nir-coin-icon.png"], { cwd: repository });
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const evidence = {
  sourceRevision: revision,
  extensionId: manifest.browser_specific_settings.gecko.id,
  version: manifest.version,
  unsignedCandidate: { file: archive.split("/").at(-1), sha256: sha256(archive) },
  reviewerSource: { file: sourceArchive.split("/").at(-1), sha256: sha256(sourceArchive) },
  packagedFiles: Object.fromEntries(files.map((file) => [file, sha256(join(source, file))])),
};
writeFileSync(join(artifacts, `nir-wallet-firefox-preview-${manifest.version}-provenance.json`), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Firefox submission candidate (unsigned; not directly installable): ${archive}`);
console.log(`Source revision: ${revision}; SHA-256: ${evidence.unsignedCandidate.sha256}`);
