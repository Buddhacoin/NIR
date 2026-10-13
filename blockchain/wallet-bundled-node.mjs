// Local rehearsal packaging only. Public distribution additionally requires
// reviewed third-party notices, a trusted publisher and notarization.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { executableBinding } from "./local-runtime-binding.mjs";

function command(program, args) {
  const result = spawnSync(program, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`bundled Node relocation failed: ${result.stderr?.trim()}`);
  return result.stdout;
}

function loads(path) {
  const lines = command("/usr/bin/otool", ["-L", path]).split("\n");
  return lines.slice(1).map((line) => line.match(/^\s+(.+?) \(compatibility version /)?.[1])
    .filter(Boolean);
}

function withinBundle(contents, absolutePath) {
  const value = relative(contents, absolutePath);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || value.startsWith(sep)) {
    throw new Error("bundled Node dependency escapes the app");
  }
  return value.split(sep).join("/");
}

export function relativeRuntimeBinding(contents, binding) {
  const canonicalContents = realpathSync(contents);
  if (binding.links.length || binding.missingDependencies.length) {
    throw new Error("bundled Node must have no symlink or missing dependency");
  }
  if (binding.logicalPath !== binding.realPath ||
      binding.dependencies.some((dependency) => dependency.logicalPath !== dependency.realPath)) {
    throw new Error("bundled Node must have no symlinked dependency");
  }
  return {
    format: "nir-local-wallet-runtime-v3",
    nodeExecutable: withinBundle(canonicalContents, binding.logicalPath),
    nodeSha256: binding.sha256,
    nodeBinding: {
      sha256: binding.sha256, size: binding.size,
      dependencies: binding.dependencies.map((dependency) => ({
        path: withinBundle(canonicalContents, dependency.logicalPath),
        sha256: dependency.sha256, size: dependency.size,
      })),
    },
  };
}

export function bundleLocalNode(contents, sourceExecutable) {
  const original = executableBinding(sourceExecutable);
  const macos = join(contents, "MacOS");
  const frameworks = join(contents, "Frameworks");
  mkdirSync(frameworks, { recursive: true });
  const node = join(macos, "node");
  copyFileSync(original.realPath, node);
  chmodSync(node, 0o755);
  const byName = new Map();
  for (const dependency of original.dependencies) {
    // Mach-O install names often use a versioned symlink name rather than
    // the final file's basename. Preserve the load name, not Homebrew's
    // resolved patch-version filename.
    const name = basename(dependency.logicalPath);
    const existing = byName.get(name);
    if (existing && existing.realPath !== dependency.realPath) {
      throw new Error("bundled Node has colliding dependency names");
    }
    byName.set(name, dependency);
  }
  for (const [name, dependency] of byName) {
    const destination = join(frameworks, name);
    copyFileSync(dependency.realPath, destination);
    chmodSync(destination, 0o755);
  }
  for (const [destination, isNode] of [[node, true],
    ...[...byName.keys()].map((name) => [join(frameworks, name), false])]) {
    for (const load of loads(destination)) {
      if (load.startsWith("/usr/lib/") || load.startsWith("/System/Library/")) continue;
      const name = basename(load);
      if (!byName.has(name)) throw new Error(`unbound bundled Node dependency: ${load}`);
      const replacement = isNode ? `@loader_path/../Frameworks/${name}` : `@loader_path/${name}`;
      command("/usr/bin/install_name_tool", ["-change", load, replacement, destination]);
    }
    // install_name_tool invalidates the source's embedded Mach-O signature.
    // This local rehearsal signature is not a publisher identity.
    command("/usr/bin/codesign", ["--force", "--sign", "-", destination]);
  }
  const bundled = executableBinding(node);
  const canonicalFrameworks = realpathSync(frameworks);
  const external = bundled.dependencies.filter((dependency) =>
    !dependency.logicalPath.startsWith(`${canonicalFrameworks}${sep}`));
  if (external.length) throw new Error(`bundled Node still loads an external dependency: ${external[0].logicalPath}`);
  const started = spawnSync(node, ["--version"], { encoding: "utf8", timeout: 10_000,
    env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin", LANG: "C" } });
  if (started.status !== 0 || started.stdout.trim() !== process.version) {
    throw new Error(`bundled Node failed its local launch check (${started.status}, ${started.signal}): ${started.stderr?.trim()}`);
  }
  return relativeRuntimeBinding(contents, bundled);
}
