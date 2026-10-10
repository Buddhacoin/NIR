import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function filesUnder(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(root, path);
    if (!entry.isFile()) throw new Error(`Archive source contains a non-regular file: ${path}`);
    return [relative(root, path).split(sep).join("/")];
  }).sort();
}

// Stored ZIP entries, sorted names, fixed DOS epoch, and fixed mode. No host
// mtimes, compression implementation, filesystem traversal order, or ZIP tool
// version can affect the submitted bytes.
export function writeDeterministicZip(root, output) {
  const chunks = [];
  const central = [];
  const names = filesUnder(root);
  let offset = 0;
  for (const name of names) {
    const nameBytes = Buffer.from(name, "utf8");
    const body = readFileSync(join(root, name));
    if (nameBytes.length > 0xffff || body.length > 0xffffffff) throw new Error(`ZIP entry too large: ${name}`);
    const checksum = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // no compression
    local.writeUInt16LE(0, 10); // 00:00:00
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x0314, 4); // Unix, ZIP version 2.0
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(body.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(0o100644 * 0x10000, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + body.length;
    if (offset > 0xffffffff) throw new Error("ZIP exceeds non-ZIP64 limits");
  }
  if (names.length > 0xffff) throw new Error("ZIP has too many files");
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  if (offset + centralSize > 0xffffffff) throw new Error("ZIP exceeds non-ZIP64 limits");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(output, Buffer.concat([...chunks, ...central, end]));
  return names;
}
