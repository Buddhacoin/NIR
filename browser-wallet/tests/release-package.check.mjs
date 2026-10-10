import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const repo = resolve(root, "..");
const artifacts = join(root, "artifacts", "firefox");
const manifest = JSON.parse(readFileSync(join(root, "dist-firefox", "manifest.json"), "utf8"));
const evidenceFile = join(artifacts, `nir-wallet-firefox-preview-${manifest.version}-provenance.json`);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("Firefox submission candidate is deterministic and tied to reviewed source", () => {
  const first = JSON.parse(readFileSync(evidenceFile, "utf8"));
  const candidate = join(artifacts, first.unsignedCandidate.file);
  const sourceArchive = join(artifacts, first.reviewerSource.file);
  const firstBytes = readFileSync(candidate);
  const sourceBytes = readFileSync(sourceArchive);
  assert.equal(first.sourceRevision, execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim());
  assert.equal(first.extensionId, manifest.browser_specific_settings.gecko.id);
  assert.equal(manifest.browser_specific_settings.gecko_android, undefined);
  assert.equal(first.unsignedCandidate.sha256, sha256(firstBytes));
  assert.equal(first.reviewerSource.sha256, sha256(sourceBytes));

  const entries = execFileSync("unzip", ["-Z", "-1", candidate], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(entries, Object.keys(first.packagedFiles));
  for (const entry of entries) {
    const packaged = execFileSync("unzip", ["-p", candidate, entry]);
    assert.equal(sha256(packaged), first.packagedFiles[entry], entry);
  }
  assert.match(execFileSync("unzip", ["-Z", "-1", sourceArchive], { encoding: "utf8" }), /browser-wallet\/src\/crypto\.js/);

  execFileSync("npm", ["run", "package:firefox"], { cwd: root });
  assert.deepEqual(readFileSync(candidate), firstBytes);
  assert.deepEqual(readFileSync(sourceArchive), sourceBytes);
  assert.deepEqual(JSON.parse(readFileSync(evidenceFile, "utf8")), first);
});
