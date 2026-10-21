// "Remove old copies" in the apps' settings: earlier local builds of NIR Wallet
// and NIR Model Lab / NIR Майнер left timestamped copies around the Mac, and
// Launchpad lists every one. This finds them by bundle identifier and moves
// them to the Trash. Wallet files and keys live in Application Support, never
// inside an app bundle, so they are not affected.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const NIR_BUNDLE_IDS = Object.freeze(["org.nir.wallet-setup-test", "org.nir.model-lab-local-test"]);
// The installed apps the Update button keeps current.
const INSTALLED_NAMES = Object.freeze(["NIR Wallet.app", "NIR Miner.app", "NIR Model Lab.app"]);
const QUERY = 'kMDItemContentType == "com.apple.application-bundle" && kMDItemFSName == "NIR*"';

function bundleId(appPath) {
  const plist = join(appPath, "Contents", "Info.plist");
  try {
    return execFileSync("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist],
      { encoding: "utf8", timeout: 5_000 }).trim();
  } catch {
    try {
      return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plist, "utf8"))?.[1] ?? null;
    } catch {
      return null;
    }
  }
}

// `installedApp` is the running app; it and its sibling installed apps in the
// same folder are kept.
export function findOldCopies(installedApp, { search = () => execFileSync("/usr/bin/mdfind", [QUERY],
  { encoding: "utf8", timeout: 20_000 }).split("\n"), home = homedir() } = {}) {
  const keep = new Set(INSTALLED_NAMES.map((name) => join(dirname(installedApp), name)));
  const trash = join(home, ".Trash");
  const found = new Set();
  for (const path of search().map((line) => line.trim()).filter(Boolean)) {
    if (!path.startsWith("/") || !path.endsWith(".app") || keep.has(path) || path.startsWith(`${trash}/`)) continue;
    // Never a bundle nested inside another app (for example a rollback copy in use).
    if (path.slice(0, -4).includes(".app/")) continue;
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) continue;
    } catch {
      continue;
    }
    if (NIR_BUNDLE_IDS.includes(bundleId(path))) found.add(path);
  }
  return [...found].sort();
}

// Moves exactly the copies findOldCopies reports now to the Trash.
export function trashOldCopies(installedApp, options = {}) {
  const home = options.home ?? homedir();
  const trash = join(home, ".Trash");
  mkdirSync(trash, { recursive: true });
  const moved = [];
  for (const path of findOldCopies(installedApp, options)) {
    let destination = join(trash, basename(path));
    for (let n = 2; existsSync(destination); n++) destination = join(trash, `${basename(path, ".app")} ${n}.app`);
    try {
      renameSync(path, destination);
      moved.push(path);
    } catch {}
  }
  return moved;
}
