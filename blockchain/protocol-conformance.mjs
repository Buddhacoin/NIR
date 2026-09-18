import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { canonicalJson, hashObject } from "./crypto.mjs";

const FORMAT = "nir-protocol-conformance-manifest-v1";
const SCHEMA = /["'](nir-[a-z0-9-]+-v[0-9]+)["']/g;
const CRYPTO_CALL = /\b(hashObject|signObject|verifyObject)\s*\(/g;
const PARAMETER_NAME = /(?:^|_)(?:MAX|MIN|LIMIT|TIMEOUT|DELAY|INTERVAL|EPOCH|CAP|THRESHOLD|DEPTH|BYTES|FILES|ENTRIES|RECEIPTS|SKEW|AGE|VERSIONS?)(?:_|$)/;
const GATE_TOKEN = /\b(?:PROTOCOL_VERSION|SUPPORTED_PROTOCOL_VERSIONS|protocolVersion|activationHeight)\b/;
const DOC_SIGNAL = /\b(?:protocol|consensus|security|release|wallet|genesis|certificate|validator|network|asset|backup|archive|beacon)\b/i;
const SOURCE_DIRECTORIES = ["blockchain", "formal"];
const TEXT_EXTENSIONS = new Set([".md", ".mjs", ".js", ".json", ".html", ".css"]);
const FORBIDDEN_NAMES = [
  "Yml0Y29pbg==", "RXRoZXJldW0=", "U29sYW5h", "RG9nZWNvaW4=", "TGl0ZWNvaW4=",
  "TW9uZXJv", "Q2FyZGFubw==", "UmlwcGxl", "VGV0aGVy", "WFJQ", "Qk5C", "VVNEVA==",
  "VVNEQw==",
].map((value) => Buffer.from(value, "base64").toString("utf8"));

function digest(bytes) {
  return `sha3-256:${createHash("sha3-256").update(bytes).digest("hex")}`;
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function filesBelow(root, directory, extension) {
  const start = join(root, directory);
  const output = [];
  const visit = (path) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name); const metadata = lstatSync(child);
      if (metadata.isSymbolicLink()) throw new Error("protocol conformance source tree contains a symlink");
      if (metadata.isDirectory()) visit(child);
      else if (metadata.isFile() && child.endsWith(extension)) output.push(child);
    }
  };
  visit(start); return output;
}

function location(root, path, index, text) {
  return { file: relative(root, path).split(sep).join("/"),
    line: text.slice(0, index).split("\n").length };
}

function addOccurrence(map, id, item) {
  if (!map.has(id)) map.set(id, []);
  const key = `${item.file}:${item.line}`;
  if (!map.get(id).some((candidate) => `${candidate.file}:${candidate.line}` === key)) map.get(id).push(item);
}

function stringConstants(text) {
  const values = new Map();
  for (const match of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*["']([A-Z][A-Z0-9_]{2,})["']/g)) {
    values.set(match[1], match[2]);
  }
  return values;
}

function callArguments(text, start) {
  const args = []; let argumentStart = start; let depth = 1; let quote = null;
  let escaped = false; let lineComment = false; let blockComment = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]; const next = text[index + 1];
    if (lineComment) { if (char === "\n") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) { args.push(text.slice(argumentStart, index).trim()); return args; }
    } else if (char === "," && depth === 1) {
      args.push(text.slice(argumentStart, index).trim()); argumentStart = index + 1;
    }
  }
  throw new Error("unterminated cryptographic call while generating protocol conformance manifest");
}

function cryptoInventory(root, path, text, domains, dynamicCalls) {
  const constants = stringConstants(text);
  for (const match of text.matchAll(CRYPTO_CALL)) {
    const args = callArguments(text, match.index + match[0].length);
    const expected = match[1] === "hashObject" ? 2 : match[1] === "signObject" ? 3 : 4;
    const expression = args[expected - 1] ?? "";
    const literal = /^["']([A-Z][A-Z0-9_]{2,})["']$/.exec(expression)?.[1] ??
      /^[A-Za-z_$][\w$]*\s*=\s*["']([A-Z][A-Z0-9_]{2,})["']$/.exec(expression)?.[1];
    const resolved = literal ?? (/^[A-Z][A-Z0-9_]*$/.test(expression) ? constants.get(expression) : undefined);
    const where = location(root, path, match.index, text);
    if (resolved) addOccurrence(domains, resolved, where);
    else dynamicCalls.push({ ...where, callee: match[1], expression: expression.replace(/\s+/g, " ").slice(0, 256) });
  }
  for (const definition of text.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g)) {
    const parameters = definition[2].split(",").map((value) => value.trim());
    const domainIndex = parameters.indexOf("domain");
    if (domainIndex < 0) continue;
    let depth = 1; let end = definition.index + definition[0].length;
    for (; end < text.length && depth > 0; end += 1) {
      if (text[end] === "{") depth += 1;
      else if (text[end] === "}") depth -= 1;
    }
    const body = text.slice(definition.index + definition[0].length, end);
    if (!/(?:hashObject|signObject|verifyObject)\s*\([^)]*\bdomain\b/s.test(body)) continue;
    const calls = new RegExp(`\\b${definition[1]}\\s*\\(`, "g");
    for (const call of text.matchAll(calls)) {
      const args = callArguments(text, call.index + call[0].length);
      const expression = args[domainIndex] ?? "";
      const literal = /^["']([A-Z][A-Z0-9_]{2,})["']$/.exec(expression)?.[1];
      const resolved = literal ?? (/^[A-Z][A-Z0-9_]*$/.test(expression) ? constants.get(expression) : undefined);
      if (resolved) addOccurrence(domains, resolved, location(root, path, call.index, text));
    }
  }
  for (const mapping of text.matchAll(/\bconst\s+domains\s*=\s*\{([\s\S]{0,4096}?)\};/g)) {
    for (const value of mapping[1].matchAll(/:\s*["']([A-Z][A-Z0-9_]{2,})["']/g)) {
      addOccurrence(domains, value[1], location(root, path, mapping.index + value.index, text));
    }
  }
}

function parameterInventory(root, path, text, parameters) {
  const declaration = /(?:^|\n)(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*([^;]+);/g;
  for (const match of text.matchAll(declaration)) {
    if (!PARAMETER_NAME.test(match[1])) continue;
    parameters.push({ ...location(root, path, match.index, text), id: match[1],
      expression: match[2].replace(/\s+/g, " ").trim() });
  }
}

function relevantNetworkLines(root, path, text) {
  const output = [];
  text.split("\n").forEach((line, index) => {
    if (/networkId/.test(line) && /(?:!==|===|hashObject|signObject|verifyObject|payload|transaction|block|manifest|anchor)/.test(line)) {
      output.push({ file: relative(root, path).split(sep).join("/"), line: index + 1,
        statement: line.trim().replace(/\s+/g, " ").slice(0, 300) });
    }
  });
  return output;
}

function relevantGateLines(root, path, text) {
  const output = [];
  text.split("\n").forEach((line, index) => {
    if (GATE_TOKEN.test(line)) output.push({ file: relative(root, path).split(sep).join("/"),
      line: index + 1, statement: line.trim().replace(/\s+/g, " ").slice(0, 300) });
  });
  return output;
}

function checkForbiddenMentions(root) {
  const findings = [];
  const inspect = (path) => {
    const relativePath = relative(root, path).split(sep).join("/");
    if (relativePath === "blockchain/protocol-conformance.mjs") return;
    const text = readFileSync(path, "utf8");
    for (const name of FORBIDDEN_NAMES) {
      if (new RegExp(`\\b${name}\\b`, "iu").test(text)) findings.push({ file: relativePath, name });
    }
  };
  for (const name of ["README.md", "package.json"]) {
    try { inspect(join(root, name)); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  for (const directory of ["blockchain", "formal", "docs", "wallet-ui"]) {
    for (const extension of TEXT_EXTENSIONS) {
      let paths = [];
      try { paths = filesBelow(root, directory, extension); } catch { continue; }
      for (const path of paths) {
        inspect(path);
      }
    }
  }
  if (findings.length > 0) throw new Error(`prohibited external-currency references: ${canonicalJson(findings)}`);
}

export function buildProtocolConformanceManifest(rootValue) {
  const root = resolve(rootValue); checkForbiddenMentions(root);
  const schemas = new Map(); const domains = new Map(); const dynamicDomainCalls = [];
  const securityParameters = []; const networkBindings = []; const featureGates = [];
  const sourceFiles = [];
  for (const directory of SOURCE_DIRECTORIES) {
    for (const path of filesBelow(root, directory, ".mjs")) {
      const text = readFileSync(path, "utf8"); const relativePath = relative(root, path).split(sep).join("/");
      let relevant = false;
      for (const match of text.matchAll(SCHEMA)) {
        addOccurrence(schemas, match[1], location(root, path, match.index, text)); relevant = true;
      }
      const beforeDomains = domains.size + dynamicDomainCalls.length;
      cryptoInventory(root, path, text, domains, dynamicDomainCalls);
      const parametersBefore = securityParameters.length;
      parameterInventory(root, path, text, securityParameters);
      const bindings = relevantNetworkLines(root, path, text); const gates = relevantGateLines(root, path, text);
      networkBindings.push(...bindings); featureGates.push(...gates);
      relevant ||= beforeDomains !== domains.size + dynamicDomainCalls.length ||
        parametersBefore !== securityParameters.length || bindings.length > 0 || gates.length > 0;
      if (relevant) sourceFiles.push({ file: relativePath, sha3_256: digest(Buffer.from(text)) });
    }
  }
  const docs = [];
  for (const path of filesBelow(root, "docs", ".md")) {
    const text = readFileSync(path, "utf8");
    if (DOC_SIGNAL.test(text)) docs.push({ file: relative(root, path).split(sep).join("/"),
      sha3_256: digest(Buffer.from(text)) });
  }
  const mapEntries = (map) => [...map].sort(([a], [b]) => compareCodePoints(a, b)).map(([id, sources]) =>
    ({ id, sources: sources.sort((a, b) => compareCodePoints(a.file, b.file) || a.line - b.line) }));
  const payload = { docs: docs.sort((a, b) => compareCodePoints(a.file, b.file)),
    domainSeparators: mapEntries(domains), dynamicDomainCalls: dynamicDomainCalls.sort((a, b) =>
      compareCodePoints(a.file, b.file) || a.line - b.line), featureGates: featureGates.sort((a, b) =>
      compareCodePoints(a.file, b.file) || a.line - b.line), format: FORMAT,
    networkBindings: networkBindings.sort((a, b) => compareCodePoints(a.file, b.file) || a.line - b.line),
    schemas: mapEntries(schemas), securityParameters: securityParameters.sort((a, b) =>
      compareCodePoints(a.id, b.id) || compareCodePoints(a.file, b.file) || a.line - b.line),
    sourceFiles: sourceFiles.sort((a, b) => compareCodePoints(a.file, b.file)), version: 1 };
  return { ...payload, manifestHash:
    `sha3-256:${hashObject(payload, "PROTOCOL_CONFORMANCE_MANIFEST_V1")}` };
}

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

export function validateProtocolConformanceManifest(value) {
  exact(value, ["docs", "domainSeparators", "dynamicDomainCalls", "featureGates", "format",
    "manifestHash", "networkBindings", "schemas", "securityParameters", "sourceFiles", "version"],
  "protocol conformance manifest");
  if (value.format !== FORMAT || value.version !== 1 ||
      !/^sha3-256:[0-9a-f]{64}$/.test(value.manifestHash ?? "")) {
    throw new Error("protocol conformance manifest header is invalid");
  }
  for (const category of ["docs", "domainSeparators", "dynamicDomainCalls", "featureGates",
    "networkBindings", "schemas", "securityParameters", "sourceFiles"]) {
    if (!Array.isArray(value[category])) throw new Error(`protocol conformance ${category} is invalid`);
  }
  for (const category of ["schemas", "domainSeparators"]) {
    const ids = value[category].map((entry) => entry?.id);
    if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length ||
        ids.some((id, index) => index > 0 && compareCodePoints(ids[index - 1], id) >= 0)) {
      throw new Error(`protocol conformance ${category} has missing, duplicate, or unordered ids`);
    }
    for (const entry of value[category]) {
      exact(entry, ["id", "sources"], `protocol conformance ${category} entry`);
      if (!Array.isArray(entry.sources) || entry.sources.length < 1) {
        throw new Error(`protocol conformance ${category} entry has no source`);
      }
      let prior = "";
      for (const source of entry.sources) {
        validateLocation(source, `protocol conformance ${category} source`);
        const key = `${source.file}:${String(source.line).padStart(12, "0")}`;
        if (compareCodePoints(key, prior) <= 0) {
          throw new Error(`protocol conformance ${category} sources are duplicate or unordered`);
        }
        prior = key;
      }
    }
  }
  for (const category of ["docs", "sourceFiles"]) {
    let prior = "";
    for (const entry of value[category]) {
      exact(entry, ["file", "sha3_256"], `protocol conformance ${category} entry`);
      validatePath(entry.file, `protocol conformance ${category} path`);
      if (!/^sha3-256:[0-9a-f]{64}$/.test(entry.sha3_256 ?? "") ||
          compareCodePoints(entry.file, prior) <= 0) {
        throw new Error(`protocol conformance ${category} is duplicate, unordered, or invalid`);
      }
      prior = entry.file;
    }
  }
  for (const entry of value.dynamicDomainCalls) {
    exact(entry, ["callee", "expression", "file", "line"], "dynamic domain call");
    validateLocation(entry, "dynamic domain call");
    if (!['hashObject', 'signObject', 'verifyObject'].includes(entry.callee) ||
        typeof entry.expression !== "string" || entry.expression.length < 1 ||
        entry.expression.length > 256) throw new Error("dynamic domain call is invalid");
  }
  for (const category of ["networkBindings", "featureGates"]) {
    for (const entry of value[category]) {
      exact(entry, ["file", "line", "statement"], `protocol conformance ${category} entry`);
      validateLocation(entry, `protocol conformance ${category} entry`);
      if (typeof entry.statement !== "string" || entry.statement.length < 1 ||
          entry.statement.length > 300) throw new Error(`protocol conformance ${category} statement is invalid`);
    }
  }
  for (const entry of value.securityParameters) {
    exact(entry, ["expression", "file", "id", "line"], "protocol security parameter");
    validateLocation(entry, "protocol security parameter");
    if (!/^[A-Z][A-Z0-9_]*$/.test(entry.id ?? "") || typeof entry.expression !== "string" ||
        entry.expression.length < 1) throw new Error("protocol security parameter is invalid");
  }
  const { manifestHash, ...payload } = value;
  if (manifestHash !== `sha3-256:${hashObject(payload, "PROTOCOL_CONFORMANCE_MANIFEST_V1")}`) {
    throw new Error("protocol conformance manifest hash is invalid");
  }
  return structuredClone(value);
}

function validatePath(path, label) {
  if (typeof path !== "string" || path.length < 1 || path.length > 512 || path.startsWith("/") ||
      path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${label} is invalid`);
  }
}

function validateLocation(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Number.isSafeInteger(value.line) || value.line < 1) throw new Error(`${label} is invalid`);
  validatePath(value.file, `${label} path`);
}

export function verifyProtocolConformanceManifest(value, root) {
  const manifest = validateProtocolConformanceManifest(value);
  const expected = buildProtocolConformanceManifest(root);
  if (canonicalJson(manifest) !== canonicalJson(expected)) {
    throw new Error("protocol conformance manifest drift detected; regenerate and review it");
  }
  return manifest;
}

export function serializeProtocolConformanceManifest(value) {
  return `${canonicalJson(validateProtocolConformanceManifest(value))}\n`;
}
