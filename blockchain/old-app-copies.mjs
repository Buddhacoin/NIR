// "Remove old copies" in the apps' settings: earlier local builds of NIR Wallet
// and NIR Model Lab / NIR Майнер left timestamped copies around the Mac, and
// Launchpad lists every one. This finds them by bundle identifier and moves
// them to the Trash. Wallet files and keys live in Application Support, never
// inside an app bundle, so they are not affected.
import { execFileSync, spawnSync } from "node:child_process";
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

// macOS keeps ~/.Trash closed to apps, so a plain rename fails there. First
// the system "move to Trash" call; if macOS refuses it for this app, Finder
// moves the copy itself (macOS may ask once to let the app control Finder).
// Foundation is loaded in JavaScript for Automation by default.
const SYSTEM_TRASH = `function run(argv) {
  if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]), null, null)) {
    throw new Error("macOS did not move the copy");
  }
}`;
// "target" is a Finder property name, so the variable is called oldCopy.
const FINDER_TRASH = `on run argv
  set oldCopy to (POSIX file (item 1 of argv)) as alias
  tell application "Finder" to delete oldCopy
end run`;

function osascript(args) {
  const result = spawnSync("/usr/bin/osascript", args, { encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) throw new Error((result.stderr || result.error?.message || "osascript failed").trim().slice(0, 300));
}

function systemTrash(path) {
  let systemError = null;
  try {
    osascript(["-l", "JavaScript", "-e", SYSTEM_TRASH, path]);
  } catch (error) {
    systemError = error;
  }
  if (!existsSync(path)) return;
  try {
    osascript(["-e", FINDER_TRASH, path]);
  } catch (error) {
    throw new Error(`${error.message}${systemError ? ` · ${systemError.message}` : ""}`.slice(0, 300));
  }
}

function renameToTrash(path, home) {
  const trash = join(home, ".Trash");
  mkdirSync(trash, { recursive: true });
  let destination = join(trash, basename(path));
  for (let n = 2; existsSync(destination); n++) destination = join(trash, `${basename(path, ".app")} ${n}.app`);
  renameSync(path, destination);
}

// Moves exactly the copies findOldCopies reports now to the Trash and says
// which ones stayed and why.
export function trashOldCopies(installedApp, options = {}) {
  const home = options.home ?? homedir();
  const moveToTrash = options.moveToTrash ??
    (process.platform === "darwin" && options.home === undefined ? systemTrash : (path) => renameToTrash(path, home));
  const moved = [];
  const failed = [];
  for (const path of findOldCopies(installedApp, options)) {
    let reason = "the copy is still in place";
    try {
      moveToTrash(path);
    } catch (error) {
      reason = String(error?.message ?? error).slice(0, 300);
    }
    if (existsSync(path)) failed.push({ path, reason });
    else moved.push(path);
  }
  return { moved, failed };
}

// "Show in Finder": the copies that could not be moved, selected in Finder
// so they can be dragged to the Trash by hand.
export function revealOldCopies(installedApp, options = {}) {
  const copies = findOldCopies(installedApp, options).slice(0, 20);
  const open = options.open ?? ((path) => spawnSync("/usr/bin/open", ["-R", path], { timeout: 10_000 }));
  for (const path of copies) open(path);
  return copies;
}
