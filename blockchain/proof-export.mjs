import { createHash } from "node:crypto";

// Proof-mining v1 profile. See docs/proof-mining.md §4. Everything a node
// needs to decide whether an exported proof solves a task is fixed here; it
// changes only through a protocol upgrade.
export const PROOF_CHECK_PROFILE_V1 = Object.freeze({
  id: "nir-proof-check-v1",
  exportFormatVersion: "3.1.0",
  leanVersion: "4.35.0",
  checker: Object.freeze({
    name: "nanoda_lib",
    version: "0.4.24",
    sourceRevision: "f67473ba5f9397266f89c7852082c9c914b5d219",
  }),
  // An axiom is allowed by its exact declaration, not by its name: a file may
  // declare `axiom propext : False` under the allowed name.
  allowedAxioms: Object.freeze({
    "Classical.choice": "1356cfd04b90f50f1724d3299942b4bab17fb968985fc14aac8bb38a53ed14a1",
    "Quot.sound": "99693a2de33cf43e13cae212933b20cdf03f216bd067d9fd2e20cc745cea4f4a",
    propext: "7406ce2c032a641b3fdd0add51aaf187380cafe212e15b29a183dee1fdc7d63d",
  }),
  statementName: "NIR.statement",
  solutionName: "NIR.solution",
  maxExportBytes: 32 * 1024 * 1024,
  maxNatLiteralDigits: 4_096,
  maxStringLiteralBytes: 65_536,
});

const BINDER_INFOS = new Set(["default", "implicit", "strictImplicit", "instImplicit"]);
const QUOT_KINDS = new Set(["type", "ctor", "lift", "ind"]);
const NAT_LITERAL = /^(?:0|[1-9][0-9]*)$/;

function fail(message) {
  throw new Error(`proof export ${message}`);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    fail(`${label} has unknown or missing fields`);
  }
}

function index(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is not a valid index`);
  return value;
}

function bool(value, label) {
  if (typeof value !== "boolean") fail(`${label} is not a boolean`);
  return value;
}

function digest(domain, value) {
  return createHash("sha3-256").update(`NIR/PROOF/${domain}/v1\0`)
    .update(JSON.stringify(value)).digest("hex");
}

class KernelExport {
  constructor(profile) {
    this.profile = profile;
    // Index 0 is the anonymous name and Level.zero; both are implicit.
    this.names = [{ components: [], hash: digest("NAME", []) }];
    this.levels = [{ hash: digest("LEVEL", ["zero"]) }];
    this.exprs = [];
    this.declarations = new Map();
    this.meta = null;
  }

  name(value, label) {
    const i = index(value, label);
    if (i >= this.names.length) fail(`${label} refers to an undefined name`);
    return this.names[i];
  }

  level(value, label) {
    const i = index(value, label);
    if (i >= this.levels.length) fail(`${label} refers to an undefined level`);
    return this.levels[i];
  }

  expr(value, label) {
    const i = index(value, label);
    if (i >= this.exprs.length) fail(`${label} refers to an undefined expression`);
    return this.exprs[i];
  }

  nameList(values, label) {
    if (!Array.isArray(values)) fail(`${label} is not an array`);
    return values.map((value) => this.name(value, label));
  }

  addName(record, assigned) {
    if (assigned !== this.names.length) fail("name indices are not sequential");
    let component;
    if ("str" in record) {
      exactKeys(record.str, ["pre", "str"], "name");
      if (typeof record.str.str !== "string") fail("name component is not a string");
      component = { s: record.str.str };
      record = record.str;
    } else {
      exactKeys(record.num, ["pre", "i"], "name");
      component = { n: index(record.num.i, "name number") };
      record = record.num;
    }
    const components = [...this.name(record.pre, "name prefix").components, component];
    this.names.push({ components, hash: digest("NAME", components) });
  }

  addLevel(kind, body, assigned) {
    if (assigned !== this.levels.length) fail("level indices are not sequential");
    let shape;
    if (kind === "param") shape = ["param", this.name(body, "level parameter").hash];
    else if (kind === "succ") shape = ["succ", this.level(body, "level").hash];
    else {
      if (!Array.isArray(body) || body.length !== 2) fail(`${kind} level is malformed`);
      shape = [kind, this.level(body[0], "level").hash, this.level(body[1], "level").hash];
    }
    this.levels.push({ hash: digest("LEVEL", shape) });
  }

  addExpr(kind, body, assigned) {
    if (assigned !== this.exprs.length) fail("expression indices are not sequential");
    let shape;
    const consts = [];
    const children = [];
    switch (kind) {
      case "bvar":
        shape = ["bvar", index(body, "bound variable")];
        break;
      case "sort":
        shape = ["sort", this.level(body, "sort level").hash];
        break;
      case "const": {
        exactKeys(body, ["name", "us"], "constant");
        if (!Array.isArray(body.us)) fail("constant levels are not an array");
        const name = this.name(body.name, "constant name");
        consts.push(name.hash);
        shape = ["const", name.hash, body.us.map((l) => this.level(l, "constant level").hash)];
        break;
      }
      case "app":
        exactKeys(body, ["fn", "arg"], "application");
        children.push(this.expr(body.fn, "function"), this.expr(body.arg, "argument"));
        shape = ["app", children[0].hash, children[1].hash];
        break;
      case "lam":
      case "forallE":
        exactKeys(body, ["name", "type", "body", "binderInfo"], kind);
        if (!BINDER_INFOS.has(body.binderInfo)) fail(`${kind} binder info is invalid`);
        children.push(this.expr(body.type, "binder type"), this.expr(body.body, "binder body"));
        shape = [kind, this.name(body.name, "binder name").hash, body.binderInfo,
          children[0].hash, children[1].hash];
        break;
      case "letE":
        exactKeys(body, ["name", "type", "value", "body", "nondep"], "let");
        children.push(this.expr(body.type, "let type"), this.expr(body.value, "let value"),
          this.expr(body.body, "let body"));
        shape = ["letE", this.name(body.name, "let name").hash, bool(body.nondep, "let nondep"),
          ...children.map((child) => child.hash)];
        break;
      case "proj": {
        exactKeys(body, ["typeName", "idx", "struct"], "projection");
        const typeName = this.name(body.typeName, "projection type");
        consts.push(typeName.hash);
        children.push(this.expr(body.struct, "projection structure"));
        shape = ["proj", typeName.hash, index(body.idx, "projection index"), children[0].hash];
        break;
      }
      case "natVal":
        if (typeof body !== "string" || !NAT_LITERAL.test(body) ||
            body.length > this.profile.maxNatLiteralDigits) {
          fail("nat literal is invalid or too long");
        }
        shape = ["nat", body];
        break;
      case "strVal":
        if (typeof body !== "string" ||
            Buffer.byteLength(body, "utf8") > this.profile.maxStringLiteralBytes) {
          fail("string literal is invalid or too long");
        }
        shape = ["str", body];
        break;
      case "mdata":
        // Metadata never affects type checking; exporting it is a different format.
        fail("must not contain metadata expressions");
        break;
      default:
        fail(`expression kind ${kind} is unknown`);
    }
    this.exprs.push({ hash: digest("EXPR", shape), consts, children });
  }

  declare(name, declaration) {
    if (this.declarations.has(name.hash)) fail("declares a constant twice");
    this.declarations.set(name.hash, { ...declaration, displayName: displayName(name) });
  }

  addDeclaration(kind, body) {
    const common = (value, extra, label) => {
      exactKeys(value, ["name", "levelParams", "type", ...extra], label);
      return {
        name: this.name(value.name, `${label} name`),
        levelParams: this.nameList(value.levelParams, `${label} level parameters`).map((n) => n.hash),
        type: this.expr(value.type, `${label} type`),
      };
    };
    if (kind === "axiom") {
      const { name, levelParams, type } = common(body, ["isUnsafe"], "axiom");
      if (bool(body.isUnsafe, "axiom unsafe flag")) fail("must not contain unsafe axioms");
      const shape = ["axiom", name.hash, levelParams, type.hash];
      this.declare(name, { kind, hash: digest("DECL", shape), roots: [type] });
    } else if (kind === "def") {
      const { name, levelParams, type } = common(body, ["value", "hints", "safety", "all"], "definition");
      if (body.safety !== "safe") fail("must contain only safe definitions");
      let hints;
      if (body.hints === "opaque" || body.hints === "abbrev") hints = body.hints;
      else {
        exactKeys(body.hints, ["regular"], "definition hints");
        hints = { regular: index(body.hints.regular, "definition height") };
      }
      const value = this.expr(body.value, "definition value");
      const all = this.nameList(body.all, "definition group").map((n) => n.hash);
      const shape = ["def", name.hash, levelParams, type.hash, value.hash, hints, all];
      this.declare(name, { kind, hash: digest("DECL", shape), roots: [type, value], type, levelParams });
    } else if (kind === "thm") {
      const { name, levelParams, type } = common(body, ["value", "all"], "theorem");
      const value = this.expr(body.value, "theorem value");
      const all = this.nameList(body.all, "theorem group").map((n) => n.hash);
      const shape = ["thm", name.hash, levelParams, type.hash, value.hash, all];
      this.declare(name, { kind, hash: digest("DECL", shape), roots: [type, value], type, levelParams });
    } else if (kind === "opaque") {
      const { name, levelParams, type } = common(body, ["value", "isUnsafe", "all"], "opaque");
      if (bool(body.isUnsafe, "opaque unsafe flag")) fail("must not contain unsafe opaques");
      const value = this.expr(body.value, "opaque value");
      const all = this.nameList(body.all, "opaque group").map((n) => n.hash);
      const shape = ["opaque", name.hash, levelParams, type.hash, value.hash, all];
      this.declare(name, { kind, hash: digest("DECL", shape), roots: [type, value] });
    } else if (kind === "quot") {
      const { name, levelParams, type } = common(body, ["kind"], "quotient");
      if (!QUOT_KINDS.has(body.kind)) fail("quotient kind is invalid");
      const shape = ["quot", name.hash, levelParams, type.hash, body.kind];
      this.declare(name, { kind, hash: digest("DECL", shape), roots: [type] });
    } else if (kind === "inductive") {
      this.addInductive(body);
    } else {
      fail(`declaration kind ${kind} is unknown`);
    }
  }

  addInductive(body) {
    exactKeys(body, ["types", "ctors", "recs"], "inductive");
    for (const key of ["types", "ctors", "recs"]) {
      if (!Array.isArray(body[key])) fail(`inductive ${key} is not an array`);
    }
    if (body.types.length === 0) fail("inductive block is empty");
    const members = [];
    const roots = [];
    const header = (value, extra, label) => {
      exactKeys(value, ["name", "levelParams", "type", "isUnsafe", ...extra], label);
      if (bool(value.isUnsafe, `${label} unsafe flag`)) fail("must not contain unsafe inductives");
      const name = this.name(value.name, `${label} name`);
      const type = this.expr(value.type, `${label} type`);
      roots.push(type);
      members.push(name);
      return [name.hash,
        this.nameList(value.levelParams, `${label} level parameters`).map((n) => n.hash), type.hash];
    };
    const types = body.types.map((value) => [...header(value,
      ["numParams", "numIndices", "all", "ctors", "numNested", "isRec", "isReflexive"], "inductive type"),
    index(value.numParams, "parameter count"), index(value.numIndices, "index count"),
    this.nameList(value.all, "inductive group").map((n) => n.hash),
    this.nameList(value.ctors, "constructor list").map((n) => n.hash),
    index(value.numNested, "nested count"), bool(value.isRec, "recursive flag"),
    bool(value.isReflexive, "reflexive flag")]);
    const ctors = body.ctors.map((value) => [...header(value,
      ["induct", "cidx", "numParams", "numFields"], "constructor"),
    this.name(value.induct, "constructor inductive").hash, index(value.cidx, "constructor index"),
    index(value.numParams, "parameter count"), index(value.numFields, "field count")]);
    const recs = body.recs.map((value) => {
      const head = header(value,
        ["all", "numParams", "numIndices", "numMotives", "numMinors", "rules", "k"], "recursor");
      if (!Array.isArray(value.rules)) fail("recursor rules are not an array");
      const rules = value.rules.map((rule) => {
        exactKeys(rule, ["ctor", "nfields", "rhs"], "recursor rule");
        const rhs = this.expr(rule.rhs, "recursor rule");
        roots.push(rhs);
        return [this.name(rule.ctor, "rule constructor").hash, index(rule.nfields, "rule fields"),
          rhs.hash];
      });
      return [...head, this.nameList(value.all, "recursor group").map((n) => n.hash),
        index(value.numParams, "parameter count"), index(value.numIndices, "index count"),
        index(value.numMotives, "motive count"), index(value.numMinors, "minor count"),
        rules, bool(value.k, "recursor k flag")];
    });
    const hash = digest("DECL", ["inductive", types, ctors, recs]);
    for (const name of members) this.declare(name, { kind: "inductive", hash, roots });
  }

  addLine(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) fail("line is not an object");
    const keys = Object.keys(record);
    const tag = ["in", "il", "ie"].find((key) => key in record);
    if (tag) {
      if (keys.length !== 2) fail("primitive has unknown or missing fields");
      const kind = keys.find((key) => key !== tag);
      const assigned = index(record[tag], "assigned index");
      if (tag === "in" && (kind === "str" || kind === "num")) this.addName(record, assigned);
      else if (tag === "il" && ["succ", "max", "imax", "param"].includes(kind)) {
        this.addLevel(kind, record[kind], assigned);
      } else if (tag === "ie") this.addExpr(kind, record[kind], assigned);
      else fail("primitive kind does not match its index tag");
      return;
    }
    if (keys.length !== 1) fail("declaration has unknown or missing fields");
    this.addDeclaration(keys[0], record[keys[0]]);
  }

  addMeta(record) {
    exactKeys(record, ["meta"], "metadata line");
    const { meta } = record;
    exactKeys(meta, ["exporter", "format", "lean"], "metadata");
    exactKeys(meta.exporter, ["name", "version"], "exporter metadata");
    exactKeys(meta.format, ["version"], "format metadata");
    exactKeys(meta.lean, ["githash", "version"], "Lean metadata");
    if (meta.format.version !== this.profile.exportFormatVersion) fail("format version is not supported");
    if (meta.lean.version !== this.profile.leanVersion) fail("Lean version does not match the profile");
    this.meta = { leanVersion: meta.lean.version, leanGithash: String(meta.lean.githash) };
  }
}

function displayName(name) {
  return name.components.map((c) => ("s" in c ? c.s : String(c.n))).join(".");
}

export function parseKernelExport(text, profile = PROOF_CHECK_PROFILE_V1) {
  if (typeof text !== "string") fail("is not text");
  if (Buffer.byteLength(text, "utf8") > profile.maxExportBytes) fail("is too large");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const result = new KernelExport(profile);
  lines.forEach((line, number) => {
    let record;
    try { record = JSON.parse(line); } catch { fail(`line ${number + 1} is not JSON`); }
    if (number === 0) result.addMeta(record);
    else result.addLine(record);
  });
  return result;
}

// Names are compared by components, never by their dotted spelling: the
// single component «NIR.statement» is a different constant from NIR.statement.
export function nameHash(dotted) {
  return digest("NAME", dotted.split(".").map((s) => ({ s })));
}

function lookup(file, dotted) {
  const hash = nameHash(dotted);
  const declaration = file.declarations.get(hash);
  return declaration ? { hash, declaration } : null;
}

// Every constant reachable from `startHash`, following both types and values.
function dependencyClosure(file, startHash) {
  const reached = new Set();
  const pending = [startHash];
  const seenExprs = new Set();
  while (pending.length > 0) {
    const hash = pending.pop();
    if (reached.has(hash)) continue;
    const declaration = file.declarations.get(hash);
    if (!declaration) fail("refers to a constant it does not declare");
    reached.add(hash);
    const exprs = [...declaration.roots];
    while (exprs.length > 0) {
      const expr = exprs.pop();
      if (seenExprs.has(expr)) continue;
      seenExprs.add(expr);
      for (const constHash of expr.consts) if (!reached.has(constHash)) pending.push(constHash);
      exprs.push(...expr.children);
    }
  }
  return reached;
}

function taskIdentity(file, profile) {
  const entries = [...file.declarations].map(([nameHash, declaration]) => [nameHash, declaration.hash])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return digest("TASK", [profile.id, entries]);
}

function rejectForeignAxioms(file, profile) {
  const allowed = new Map(Object.entries(profile.allowedAxioms)
    .map(([dotted, hash]) => [nameHash(dotted), hash]));
  for (const [hash, declaration] of file.declarations) {
    if (declaration.kind === "axiom" && allowed.get(hash) !== declaration.hash) {
      fail(`declares the forbidden axiom ${declaration.displayName}`);
    }
  }
}

// A task is the closure of one definition `NIR.statement : Prop`.
export function inspectProofTask(text, profile = PROOF_CHECK_PROFILE_V1) {
  const file = parseKernelExport(text, profile);
  rejectForeignAxioms(file, profile);
  const statement = lookup(file, profile.statementName);
  if (!statement || statement.declaration.kind !== "def" ||
      statement.declaration.levelParams.length !== 0 ||
      statement.declaration.type.hash !== digest("EXPR", ["sort", file.levels[0].hash])) {
    fail("task must define NIR.statement : Prop without universe parameters");
  }
  if (lookup(file, profile.solutionName)) fail("task must not contain a solution");
  dependencyClosure(file, statement.hash);
  return { file, taskId: taskIdentity(file, profile), statementHash: statement.declaration.hash };
}

// The node-side policy half of verification. The kernel half is
// `proof-kernel.mjs`; a submission is accepted only when both pass.
export function checkProofSolution(taskText, solutionText, profile = PROOF_CHECK_PROFILE_V1) {
  const task = inspectProofTask(taskText, profile);
  const solution = parseKernelExport(solutionText, profile);
  rejectForeignAxioms(solution, profile);
  for (const [nameHash, declaration] of task.file.declarations) {
    const ours = solution.declarations.get(nameHash);
    if (!ours || ours.hash !== declaration.hash) {
      fail(`changes the task declaration ${declaration.displayName}`);
    }
  }
  const theorem = lookup(solution, profile.solutionName);
  const statement = lookup(solution, profile.statementName);
  const expectedType = digest("EXPR", ["const", statement.hash, []]);
  if (!theorem || theorem.declaration.kind !== "thm" || theorem.declaration.levelParams.length !== 0 ||
      theorem.declaration.type.hash !== expectedType) {
    fail("must prove exactly NIR.statement as the theorem NIR.solution");
  }
  const axioms = [...dependencyClosure(solution, theorem.hash)]
    .map((hash) => solution.declarations.get(hash))
    .filter((declaration) => declaration.kind === "axiom")
    .map((declaration) => declaration.displayName).sort();
  return {
    taskId: task.taskId,
    solutionHash: createHash("sha3-256").update(solutionText).digest("hex"),
    axioms,
  };
}
