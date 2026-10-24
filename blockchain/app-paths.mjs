// Where NIR Wallet and NIR Майнер keep their files on each system. A Mac
// keeps the folders its apps have always used; Linux follows the XDG data
// directory and Windows the per-user local application data folder.
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import process from "node:process";

// Paths in the target system's own form, also when computed elsewhere.
const join = (platform, ...parts) => (platform === "win32" ? win32 : posix).join(...parts);

function systemDataRoot({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === "win32") return join(platform, env.LOCALAPPDATA || join(platform, home, "AppData", "Local"), "NIR");
  const base = env.XDG_DATA_HOME?.startsWith("/") ? env.XDG_DATA_HOME : join(platform, home, ".local", "share");
  return join(platform, base, "nir");
}

export function walletStorageRoot(options = {}) {
  const { platform = process.platform, home = homedir() } = options;
  if (platform === "darwin") return join(platform, home, "Library", "Application Support", "NIR Wallet");
  return join(platform, systemDataRoot(options), platform === "win32" ? "Wallet" : "wallet");
}

export function miningDataDirectory(options = {}) {
  const { platform = process.platform, env = process.env, home = homedir() } = options;
  if (env.NIR_MODEL_LAB_DATA) return env.NIR_MODEL_LAB_DATA;
  if (platform === "darwin") return join(platform, home, "Library", "Application Support", "NIR Model Lab", "mining");
  return join(platform, systemDataRoot(options), platform === "win32" ? "Miner" : "miner");
}

// The private browser profile the app windows open in: no extensions, no
// history shared with the person's everyday browser.
export function appWindowProfile(options = {}) {
  const { platform = process.platform } = options;
  return join(platform, systemDataRoot(options), platform === "win32" ? "Window" : "window");
}
