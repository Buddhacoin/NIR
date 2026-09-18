import { closeSync, fstatSync, readSync } from "node:fs";
import process from "node:process";

const MAX_PASSWORD_BYTES = 1_024;

function descriptorAvailable(descriptor) {
  try { fstatSync(descriptor); return true; }
  catch (error) {
    if (error?.code === "EBADF") return false;
    throw error;
  }
}

function trimTerminator(value) {
  let end = value.length;
  if (end > 0 && value[end - 1] === 10) end -= 1;
  if (end > 0 && value[end - 1] === 13) end -= 1;
  return Buffer.from(value.subarray(0, end));
}

export function readRestrictedPasswordFd(descriptor, label) {
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 1_024) {
    throw new Error(`${label} password descriptor is invalid`);
  }
  const metadata = fstatSync(descriptor);
  if ((!metadata.isFIFO() && !metadata.isSocket() && !metadata.isFile()) ||
      (metadata.isFile() && (metadata.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error(`${label} password descriptor is not restricted to this owner`);
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.alloc(256);
    const length = readSync(descriptor, chunk, 0, chunk.length, null);
    if (length === 0) break;
    total += length;
    if (total > MAX_PASSWORD_BYTES + 2) {
      chunk.fill(0);
      for (const prior of chunks) prior.fill(0);
      throw new Error(`${label} password is too large`);
    }
    chunks.push(chunk.subarray(0, length));
  }
  const joined = Buffer.concat(chunks, total);
  for (const chunk of chunks) chunk.fill(0);
  const password = trimTerminator(joined);
  joined.fill(0);
  if (password.length < 12 || password.length > MAX_PASSWORD_BYTES ||
      password.includes(0) || password.includes(10) || password.includes(13)) {
    password.fill(0);
    throw new Error(`${label} password from inherited descriptor is invalid`);
  }
  return password;
}

function readInteractivePassword(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      reject(new Error("ceremony vault passwords require an interactive TTY or inherited FDs 3 and 4"));
      return;
    }
    process.stdout.write(prompt);
    const bytes = [];
    const finish = (error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(Buffer.from(bytes));
      bytes.fill(0);
    };
    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error("cancelled"));
        if (byte === 13 || byte === 10) return finish();
        if (byte === 127 || byte === 8) bytes.pop();
        else if (byte >= 32 && bytes.length < MAX_PASSWORD_BYTES) bytes.push(byte);
        else if (bytes.length >= MAX_PASSWORD_BYTES) return finish(new Error("password is too large"));
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

export async function readCeremonyPasswordBuffers() {
  const validatorFd = descriptorAvailable(3);
  const transportFd = descriptorAvailable(4);
  if (validatorFd !== transportFd) {
    throw new Error("ceremony startup requires both inherited password FDs 3 and 4");
  }
  if (validatorFd) {
    const consume = (descriptor, label) => {
      try { return readRestrictedPasswordFd(descriptor, label); }
      finally { closeSync(descriptor); }
    };
    const validatorPasswordBuffer = consume(3, "validator vault");
    try {
      return {
        transportPasswordBuffer: consume(4, "transport vault"),
        validatorPasswordBuffer,
      };
    } catch (error) {
      validatorPasswordBuffer.fill(0);
      throw error;
    }
  }
  const validatorPasswordBuffer = await readInteractivePassword("Validator vault password: ");
  try {
    return {
      transportPasswordBuffer: await readInteractivePassword("Transport vault password: "),
      validatorPasswordBuffer,
    };
  } catch (error) {
    validatorPasswordBuffer.fill(0);
    throw error;
  }
}
