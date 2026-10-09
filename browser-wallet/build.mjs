import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname);
const output = join(root, "dist");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
await build({
  entryPoints: [join(root, "src/app.js")],
  outfile: join(output, "app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  loader: { ".txt": "text" },
  legalComments: "external",
  sourcemap: false,
  minify: false,
});
for (const name of ["manifest.json", "wallet.html", "style.css", "background.js"]) {
  copyFileSync(join(root, "src", name), join(output, name));
}
copyFileSync(join(root, "../wallet-ui/nir-coin-icon.png"), join(output, "nir-icon.png"));
const license = ["@noble/hashes", "@noble/post-quantum"].map((name) => {
  const pkg = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"));
  const notice = readFileSync(join(root, "node_modules", name, "LICENSE"), "utf8");
  return `${name} ${pkg.version} (${pkg.license ?? "see package"})\n\n${notice.trim()}`;
});
writeFileSync(join(output, "THIRD-PARTY.txt"), `${license.join("\n\n---\n\n")}\n`);
console.log(`Browser wallet built: ${output}`);
