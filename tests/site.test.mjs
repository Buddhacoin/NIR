import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the Mac installer is valid bash, pins Node.js like the server, and verifies what it downloads", () => {
  const installer = read("site/install.sh");
  assert.equal(spawnSync("bash", ["-n", "site/install.sh"], { cwd: new URL("..", import.meta.url) }).status, 0);
  const pinned = (text) => /NODE_VERSION="([0-9.]+)"/.exec(text)[1];
  assert.equal(pinned(installer), pinned(read("deploy/install-shared-testnet.sh")));
  assert.match(installer, /shasum -a 256 -c/);
  assert.match(installer, /pkgutil --check-signature/);
  assert.match(installer, /Developer ID Installer: Python Software Foundation/);
  assert.match(installer, /^set -euo pipefail$/m);
  assert.doesNotMatch(installer, /\bread\b -/, "piped from curl, the script cannot read answers");
});

test("the website links only files it ships and shows the same install command", () => {
  const html = read("site/index.html");
  for (const [, file] of html.matchAll(/(?:src|href)="([^"#:?]+)(?:\?[^"]*)?"/g)) {
    assert.ok(existsSync(new URL(`../site/${file}`, import.meta.url)), `missing ${file}`);
  }
  // A versioned URL makes browsers drop a cached stylesheet or script from an older page.
  assert.match(html, /href="style\.css\?v=\d+"/);
  assert.match(html, /src="app\.js\?v=\d+"/);
  assert.match(html, /curl -fsSL https:\/\/nircoin\.com\/install\.sh \| bash/);
  assert.match(read("docs/install-mac.md"), /curl -fsSL https:\/\/nircoin\.com\/install\.sh \| bash/);
  const app = read("site/app.js");
  for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) {
    assert.match(app, new RegExp(`\\b${key}:`), `no English text for ${key}`);
  }
});

test("the server serves the website with the network's read API under /api", () => {
  const script = read("deploy/install-shared-testnet.sh");
  assert.match(script, /SITE_DOMAIN="\$\{2:-\}"/);
  assert.match(script, /handle_path \/api\/\* \{\n\s+reverse_proxy 127\.0\.0\.1:8787/);
  assert.match(script, /root \* \$APP_DIR\/site/);
  assert.equal(spawnSync("bash", ["-n", "deploy/install-shared-testnet.sh"],
    { cwd: new URL("..", import.meta.url) }).status, 0);
});
