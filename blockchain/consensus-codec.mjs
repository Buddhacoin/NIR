import { types as utilTypes } from "node:util";

export const CONSENSUS_ENCODING_VERSION = 1;

const PROTOCOL_ENCODINGS = Object.freeze(new Map([
  [24, 1],
  [25, 1],
  [26, 1],
  [27, 1],
  [28, 1],
  [29, 1],
  [30, 1],
  [31, 1],
  [32, 1],
]));

const PREFIX = Buffer.from("NIR-CONSENSUS", "ascii");
const MAX_DEPTH = 64;
const MAX_CONTAINER_ENTRIES = 100_000;
const MAX_STRING_BYTES = 16 * 1024 * 1024;
const MAX_ENCODED_BYTES = 64 * 1024 * 1024;
const DOMAIN = /^[A-Z0-9_-]{1,40}$/;

export function consensusEncodingVersionForProtocol(protocolVersion) {
  const version = PROTOCOL_ENCODINGS.get(protocolVersion);
  if (version === undefined) {
    throw new Error(`protocol version ${protocolVersion} has no consensus encoding`);
  }
  return version;
}

function u32(value) {
  const encoded = Buffer.allocUnsafe(4);
  encoded.writeUInt32BE(value);
  return encoded;
}

function validUnicodeScalarString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function stringBytes(value, field) {
  if (!validUnicodeScalarString(value)) {
    throw new Error(`${field} contains an unpaired Unicode surrogate`);
  }
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > MAX_STRING_BYTES) throw new Error(`${field} is too large`);
  return encoded;
}

function ordinaryPrototype(value, expected, field) {
  if (utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== expected) {
    throw new Error(`${field} has an exotic prototype or proxy`);
  }
}

function dataDescriptor(value, key, field) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    throw new Error(`${field} contains an accessor or non-enumerable field`);
  }
  return descriptor.value;
}

function sortedObjectEntries(value, field) {
  ordinaryPrototype(value, Object.prototype, field);
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_CONTAINER_ENTRIES || keys.some((key) => typeof key !== "string")) {
    throw new Error(`${field} has too many fields or a symbol key`);
  }
  const normalized = new Set();
  let keyBytes = 0;
  const entries = keys.map((key) => {
    const bytes = stringBytes(key, `${field} key`);
    keyBytes += bytes.length;
    if (keyBytes > MAX_ENCODED_BYTES) throw new Error("consensus value is too large");
    const nfc = key.normalize("NFC");
    if (nfc !== key || normalized.has(nfc)) {
      throw new Error(`${field} contains an ambiguous non-NFC key`);
    }
    normalized.add(nfc);
    return { bytes, key, value: dataDescriptor(value, key, field) };
  });
  entries.sort((left, right) => Buffer.compare(left.bytes, right.bytes));
  return entries;
}

function arrayValues(value, field) {
  ordinaryPrototype(value, Array.prototype, field);
  if (value.length > MAX_CONTAINER_ENTRIES) throw new Error(`${field} is too large`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" ||
      (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))) {
    throw new Error(`${field} contains a symbol or extra field`);
  }
  if (keys.length !== value.length + 1) throw new Error(`${field} is sparse`);
  const values = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    if (!Object.hasOwn(value, key)) throw new Error(`${field} is sparse`);
    values.push(dataDescriptor(value, key, field));
  }
  return values;
}

function append(context, ...values) {
  for (const value of values) {
    if (context.total + value.length > MAX_ENCODED_BYTES) {
      throw new Error("consensus value is too large");
    }
    context.total += value.length;
    context.chunks.push(value);
  }
}

function encodeValue(value, context, active, depth, field) {
  if (depth > MAX_DEPTH) throw new Error("consensus value nesting is too deep");
  if (value === null) {
    append(context, Buffer.from([0x00]));
    return;
  }
  if (value === false) {
    append(context, Buffer.from([0x01]));
    return;
  }
  if (value === true) {
    append(context, Buffer.from([0x02]));
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error(`${field} must be an unambiguous safe integer`);
    }
    const encoded = Buffer.allocUnsafe(9);
    encoded[0] = 0x03;
    encoded.writeBigInt64BE(BigInt(value), 1);
    append(context, encoded);
    return;
  }
  if (typeof value === "string") {
    const encoded = stringBytes(value, field);
    append(context, Buffer.from([0x04]), u32(encoded.length), encoded);
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`${field} contains an unsupported value type`);
  }
  if (active.has(value)) throw new Error("consensus value contains a cycle");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const values = arrayValues(value, field);
      append(context, Buffer.from([0x05]), u32(values.length));
      values.forEach((entry, index) => {
        encodeValue(entry, context, active, depth + 1, `${field}[${index}]`);
      });
      return;
    }
    const entries = sortedObjectEntries(value, field);
    append(context, Buffer.from([0x06]), u32(entries.length));
    for (const entry of entries) {
      append(context, Buffer.from([0x04]), u32(entry.bytes.length), entry.bytes);
      encodeValue(entry.value, context, active, depth + 1, `${field}.${entry.key}`);
    }
  } finally {
    active.delete(value);
  }
}

export function consensusValueBytes(value) {
  const context = { chunks: [], total: 0 };
  encodeValue(value, context, new WeakSet(), 0, "consensus value");
  return Buffer.concat(context.chunks, context.total);
}

function envelopePrefix(domain, encodingVersion) {
  if (!DOMAIN.test(domain ?? "")) throw new Error("invalid cryptographic domain");
  if (encodingVersion !== CONSENSUS_ENCODING_VERSION) {
    throw new Error("unsupported consensus encoding version");
  }
  const domainBytes = Buffer.from(domain, "ascii");
  return Buffer.concat([
    PREFIX,
    Buffer.from([0x00, 0x00, encodingVersion, domainBytes.length]),
    domainBytes,
  ]);
}

export function consensusArrayEnvelopeHeader(domain, length, {
  encodingVersion = CONSENSUS_ENCODING_VERSION,
} = {}) {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CONTAINER_ENTRIES) {
    throw new Error("consensus array length is invalid");
  }
  return Buffer.concat([
    envelopePrefix(domain, encodingVersion), Buffer.from([0x05]), u32(length),
  ]);
}

export function consensusEnvelopeBytes(domain, value, options = {}) {
  return Buffer.concat([
    envelopePrefix(domain, options.encodingVersion ?? CONSENSUS_ENCODING_VERSION),
    consensusValueBytes(value),
  ]);
}

function jsonValue(value, active, depth, field) {
  if (depth > MAX_DEPTH) throw new Error("consensus value nesting is too deep");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error(`${field} must be an unambiguous safe integer`);
    }
    return String(value);
  }
  if (typeof value === "string") {
    stringBytes(value, field);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error(`${field} contains an unsupported value type`);
  }
  if (active.has(value)) throw new Error("consensus value contains a cycle");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const values = arrayValues(value, field);
      return `[${values.map((entry, index) =>
        jsonValue(entry, active, depth + 1, `${field}[${index}]`)).join(",")}]`;
    }
    const entries = sortedObjectEntries(value, field);
    return `{${entries.map((entry) => `${JSON.stringify(entry.key)}:${
      jsonValue(entry.value, active, depth + 1, `${field}.${entry.key}`)}`).join(",")}}`;
  } finally {
    active.delete(value);
  }
}

export function strictCanonicalJson(value) {
  // Enforce the same aggregate bounds before constructing a JSON string.
  consensusValueBytes(value);
  return jsonValue(value, new WeakSet(), 0, "consensus value");
}
