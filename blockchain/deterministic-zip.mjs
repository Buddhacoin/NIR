import { createHash } from "node:crypto";

const MAX_ENTRIES = 20_000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(contents) {
  let crc = 0xffffffff;
  for (const byte of contents) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pathBuffer(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 ||
      value.startsWith("/") || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value) ||
      value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("ZIP entry path is invalid");
  }
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > 0xffff) throw new Error("ZIP entry path is too long");
  return encoded;
}

export function createDeterministicZip(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_ENTRIES) {
    throw new Error("ZIP entry list is invalid");
  }
  const normalized = entries.map((entry) => ({
    contents: Buffer.isBuffer(entry?.contents) ? entry.contents : Buffer.from(entry?.contents ?? ""),
    executable: entry?.executable === true,
    name: pathBuffer(entry?.path),
    path: entry?.path,
  })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (new Set(normalized.map(({ path }) => path)).size !== normalized.length) {
    throw new Error("ZIP entry paths must be unique");
  }
  let total = 0;
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of normalized) {
    total += entry.contents.length;
    if (entry.contents.length > 0xffffffff || total > MAX_TOTAL_BYTES) {
      throw new Error("ZIP contents are too large");
    }
    const checksum = crc32(entry.contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.contents.length, 18);
    local.writeUInt32LE(entry.contents.length, 22);
    local.writeUInt16LE(entry.name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, entry.name, entry.contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.contents.length, 20);
    central.writeUInt32LE(entry.contents.length, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((entry.executable ? 0o100755 : 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, entry.name);
    offset += local.length + entry.name.length + entry.contents.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(normalized.length, 8);
  end.writeUInt16LE(normalized.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function zipSha3(contents) {
  return createHash("sha3-256").update("NIR/EXTENSION_ZIP/v1\0").update(contents).digest("hex");
}
