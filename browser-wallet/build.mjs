import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname);
const firefox = process.argv.includes("--firefox");
const output = join(root, firefox ? "dist-firefox" : "dist");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
await build({
  entryPoints: [join(root, "src/app.js")],
  outfile: join(output, "app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: firefox ? "firefox128" : "chrome120",
  loader: { ".txt": "text" },
  legalComments: "external",
  sourcemap: false,
  minify: false,
});
for (const name of ["wallet.html", "style.css", "background.js"]) {
  copyFileSync(join(root, "src", name), join(output, name));
}
const manifest = JSON.parse(readFileSync(join(root, "src/manifest.json"), "utf8"));
if (firefox) {
  manifest.background = { scripts: ["background.js"] };
  manifest.icons = { "256": "nir-icon.png" };
  manifest.browser_specific_settings = {
    gecko: {
      id: "{f6c10a9d-98f5-4f3f-9ee7-6c43986f472a}",
      strict_min_version: "142.0",
      data_collection_permissions: { required: ["none"] },
    },
    gecko_android: { strict_min_version: "142.0" },
  };
}
writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
copyFileSync(join(root, "../wallet-ui/nir-coin-icon.png"), join(output, "nir-icon.png"));
const license = ["@noble/hashes", "@noble/post-quantum"].map((name) => {
  const pkg = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"));
  const notice = readFileSync(join(root, "node_modules", name, "LICENSE"), "utf8");
  return `${name} ${pkg.version} (${pkg.license ?? "see package"})\n\n${notice.trim()}`;
});
writeFileSync(join(output, "THIRD-PARTY.txt"), `${license.join("\n\n---\n\n")}\n`);
console.log(`Browser wallet built: ${output}`);
