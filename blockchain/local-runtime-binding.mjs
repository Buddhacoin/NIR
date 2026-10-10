import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_TREE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_TREE_ENTRIES = 50_000;
function encoded(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\n") ||
      Buffer.byteLength(value) > 4096) throw new Error("Python environment path is invalid");
  return Buffer.from(value, "utf8").toString("base64");
}

function sha256File(path, maximum = MAX_EXECUTABLE_BYTES) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > maximum) {
    throw new Error("runtime executable is not a bounded regular file");
  }
  return { sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), size: stat.size };
}

export function executableBinding(logicalPath) {
  if (typeof logicalPath !== "string" || !isAbsolute(logicalPath)) {
    throw new Error("runtime executable path must be absolute");
  }
  const requested = resolve(logicalPath);
  // Pin every directory component now, while retaining the final executable
  // symlink itself.  A virtual environment needs bin/python's symlink name for
  // sys.prefix discovery, but a mutable ancestor alias must never decide which
  // environment the signed launcher executes later.
  const pinnedPath = join(realpathSync(dirname(requested)), basename(requested));
  const links = [];
  let cursor = pinnedPath;
  for (let depth = 0; depth < 16 && lstatSync(cursor).isSymbolicLink(); depth += 1) {
    const target = readlinkSync(cursor);
    links.push({ path: cursor, target });
    cursor = resolve(dirname(cursor), target);
  }
  if (lstatSync(cursor).isSymbolicLink()) throw new Error("runtime symlink chain is too deep");
  const realPath = realpathSync(pinnedPath);
  if (cursor !== realPath) throw new Error("runtime symlink resolution is ambiguous");
  return { logicalPath: pinnedPath, realPath, links, ...sha256File(realPath) };
}

function inside(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

export function environmentBinding(rootPath, executableRealPath) {
  const root = realpathSync(rootPath);
  if (!lstatSync(root).isDirectory()) throw new Error("Python environment root is not a directory");
  const records = [];
  const externalLinks = [];
  const brokenLinks = [];
  let bytes = 0;
  let entries = 0;
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const rel = relative(root, path).split(sep).join("/");
      const encodedRelative = encoded(rel);
      if (++entries > MAX_TREE_ENTRIES) {
        throw new Error("Python environment exceeds binding limits");
      }
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        records.push(`D\t${encodedRelative}\n`);
        visit(path);
      } else if (stat.isFile()) {
        if (stat.size > MAX_EXECUTABLE_BYTES || bytes + stat.size > MAX_TREE_BYTES) {
          throw new Error("Python environment file exceeds binding limits");
        }
        bytes += stat.size;
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
        records.push(`F\t${encodedRelative}\t${stat.size}\t${digest}\n`);
      } else if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        const encodedTarget = encoded(target);
        let resolved = null;
        try { resolved = realpathSync(path); }
        catch (error) {
          if (error.code !== "ENOENT") throw error;
          brokenLinks.push(rel);
        }
        if (resolved !== null && !inside(root, resolved)) {
          if (resolved !== executableRealPath || !rel.startsWith("bin/")) {
            throw new Error("Python environment contains an unbound external symlink");
          }
          externalLinks.push(rel);
        }
        records.push(`L\t${encodedRelative}\t${encodedTarget}\n`);
      } else throw new Error("Python environment contains an unsupported filesystem entry");
    }
  };
  visit(root);
  records.sort();
  const hash = createHash("sha256");
  for (const record of records) hash.update(record);
  return { root, entries: records.length, bytes, brokenLinks: brokenLinks.sort(),
    externalLinks: externalLinks.sort(), treeSha256: hash.digest("hex") };
}

export function createRuntimeBinding({ nodePath, pythonPath, pythonPrefix, pythonBasePrefix }) {
  const nodeExecutable = executableBinding(nodePath);
  const pythonExecutable = executableBinding(pythonPath);
  const prefix = realpathSync(pythonPrefix);
  const basePrefix = realpathSync(pythonBasePrefix);
  const pythonEnvironment = prefix === basePrefix ? null : environmentBinding(prefix, pythonExecutable.realPath);
  const pythonBaseEnvironment = environmentBinding(basePrefix, pythonExecutable.realPath);
  if (pythonEnvironment && !inside(prefix, realpathSync(dirname(pythonPath)))) {
    throw new Error("Python executable is outside its virtual environment");
  }
  return { format: "nir-local-runtime-binding-v1", nodeExecutable, pythonExecutable,
    pythonBaseEnvironment, pythonEnvironment };
}
