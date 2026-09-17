const MAX_DEPTH = 64;

function validUnicodeScalarString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

export function parseConsensusJson(input) {
  if (typeof input !== "string") throw new Error("consensus JSON input must be a string");
  let position = 0;

  function fail() { throw new Error("consensus JSON is not canonical data"); }
  function whitespace() {
    while (position < input.length && /[\x20\t\r\n]/.test(input[position])) position += 1;
  }
  function string() {
    const start = position;
    if (input[position] !== '"') fail();
    position += 1;
    let escaped = false;
    while (position < input.length) {
      const code = input.charCodeAt(position);
      if (!escaped && code === 0x22) {
        position += 1;
        let parsed;
        try { parsed = JSON.parse(input.slice(start, position)); } catch { fail(); }
        if (!validUnicodeScalarString(parsed)) fail();
        return parsed;
      }
      if (!escaped && code < 0x20) fail();
      if (!escaped && code === 0x5c) escaped = true;
      else escaped = false;
      position += 1;
    }
    fail();
  }
  function number() {
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(input.slice(position));
    if (!match) fail();
    position += match[0].length;
    const parsed = Number(match[0]);
    if (!Number.isSafeInteger(parsed) || Object.is(parsed, -0)) fail();
    return parsed;
  }
  function value(depth) {
    if (depth > MAX_DEPTH) fail();
    whitespace();
    if (input.startsWith("null", position)) { position += 4; return null; }
    if (input.startsWith("true", position)) { position += 4; return true; }
    if (input.startsWith("false", position)) { position += 5; return false; }
    if (input[position] === '"') return string();
    if (input[position] === "[") {
      position += 1;
      whitespace();
      const result = [];
      if (input[position] === "]") { position += 1; return result; }
      while (true) {
        result.push(value(depth + 1));
        whitespace();
        if (input[position] === "]") { position += 1; return result; }
        if (input[position] !== ",") fail();
        position += 1;
      }
    }
    if (input[position] === "{") {
      position += 1;
      whitespace();
      const result = {};
      const seen = new Set();
      if (input[position] === "}") { position += 1; return result; }
      while (true) {
        whitespace();
        const key = string();
        if (key.normalize("NFC") !== key || seen.has(key)) fail();
        seen.add(key);
        whitespace();
        if (input[position] !== ":") fail();
        position += 1;
        Object.defineProperty(result, key, {
          configurable: true, enumerable: true, value: value(depth + 1), writable: true,
        });
        whitespace();
        if (input[position] === "}") { position += 1; return result; }
        if (input[position] !== ",") fail();
        position += 1;
      }
    }
    return number();
  }

  whitespace();
  const parsed = value(0);
  whitespace();
  if (position !== input.length) fail();
  return parsed;
}
