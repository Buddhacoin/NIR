import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_TREE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_TREE_ENTRIES = 50_000;
const MAX_DEPENDENCY_FILES = 512;
const MAX_DEPENDENCY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_DEPENDENCY_CONTEXTS = 1024;
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

function otool(path, flag) {
  const result = spawnSync("/usr/bin/otool", [flag, path], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`runtime Mach-O inspection failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function machoDescription(path) {
  const dependencies = [];
  for (const line of otool(path, "-L").split("\n")) {
    if (!line) continue;
    if (!/^\s/.test(line) && line.endsWith(":")) continue;
    const match = line.match(/^\s+(.+?) \(compatibility version /);
    if (!match) throw new Error("runtime contains an unparseable Mach-O dependency");
    dependencies.push(match[1]);
  }
  const identities = new Set();
  for (const line of otool(path, "-D").split("\n")) {
    if (!line) continue;
    if (!/^\s/.test(line) && line.endsWith(":")) continue;
    if (/^\s/.test(line) || !(line.startsWith("/") || line.startsWith("@"))) {
      throw new Error("runtime contains an unparseable Mach-O identity");
    }
    identities.add(line);
  }
  const rpaths = [];
  let awaitingPath = false;
  for (const line of otool(path, "-l").split("\n")) {
    const value = line.trim();
    if (value === "cmd LC_RPATH") awaitingPath = true;
    else if (awaitingPath) {
      const match = value.match(/^path (.+) \(offset \d+\)$/);
      if (match) { rpaths.push(match[1]); awaitingPath = false; }
    }
  }
  return { dependencies: dependencies.filter((value) => !identities.has(value)), rpaths };
}

function expandedPath(value, loaderPath, executablePath) {
  if (value.startsWith("/")) return resolve(value);
  if (value === "@loader_path") return dirname(loaderPath);
  if (value.startsWith("@loader_path/")) return resolve(dirname(loaderPath), value.slice(13));
  if (value === "@executable_path") return dirname(executablePath);
  if (value.startsWith("@executable_path/")) return resolve(dirname(executablePath), value.slice(17));
  return null;
}

function isSystemLibrary(path) {
  return path.startsWith("/usr/lib/") || path.startsWith("/System/Library/");
}

function dependencyClosure(executablePath) {
  const executableReal = realpathSync(executablePath);
  const records = new Map();
  const missing = new Set();
  const visited = new Set();
  let totalBytes = 0;
  const visit = (file, inheritedRpaths = []) => {
    const fileReal = realpathSync(file);
    const inherited = [...new Set(inheritedRpaths)];
    const context = `${fileReal}\0${inherited.join("\0")}`;
    if (visited.has(context)) return;
    if (visited.size >= MAX_DEPENDENCY_CONTEXTS) {
      throw new Error("runtime dependency resolution exceeds context limits");
    }
    visited.add(context);
    const description = machoDescription(fileReal);
    const ownRpaths = description.rpaths.map((value) => expandedPath(value, fileReal, executableReal));
    if (ownRpaths.some((value) => value === null)) throw new Error("runtime contains an unsupported Mach-O rpath");
    const rpaths = [...new Set([...ownRpaths, ...inherited])];
    for (const installName of description.dependencies) {
      let logicalPath = expandedPath(installName, fileReal, executableReal);
      if (!logicalPath && installName.startsWith("@rpath/")) {
        const suffix = installName.slice(7);
        for (const root of rpaths) {
          const candidate = resolve(root, suffix);
          try { realpathSync(candidate); logicalPath = candidate; break; } catch (error) {
            if (error.code !== "ENOENT") throw error;
            try {
              lstatSync(candidate);
              throw new Error("runtime dependency candidate is a broken symlink");
            } catch (candidateError) {
              if (candidateError.code !== "ENOENT") throw candidateError;
            }
            if (missing.size >= MAX_DEPENDENCY_FILES && !missing.has(candidate)) {
              throw new Error("runtime dependency closure exceeds binding limits");
            }
            missing.add(candidate);
          }
        }
      }
      if (!logicalPath) throw new Error(`runtime contains an unresolved dependency: ${installName}`);
      if (isSystemLibrary(logicalPath)) continue;
      const realPath = realpathSync(logicalPath);
      if (isSystemLibrary(realPath)) continue;
      const identity = sha256File(realPath);
      const key = resolve(logicalPath);
      if (!records.has(key)) {
        if (records.size >= MAX_DEPENDENCY_FILES || totalBytes + identity.size > MAX_DEPENDENCY_BYTES) {
          throw new Error("runtime dependency closure exceeds binding limits");
        }
        totalBytes += identity.size;
        records.set(key, { logicalPath: key, realPath, ...identity });
      }
      visit(realPath, rpaths);
    }
  };
  visit(executableReal);
  return { dependencies: [...records.values()].sort((left, right) =>
    left.logicalPath.localeCompare(right.logicalPath)), missingDependencies: [...missing].sort() };
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
  const closure = dependencyClosure(pinnedPath);
  return { logicalPath: pinnedPath, realPath, links, ...closure, ...sha256File(realPath) };
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
  return { format: "nir-local-runtime-binding-v2", nodeExecutable, pythonExecutable,
    pythonBaseEnvironment, pythonEnvironment };
}
