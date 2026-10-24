// Where NIR Wallet and NIR Майнер keep their files on each system. A Mac
// keeps the folders its apps have always used; Linux follows the XDG data
// directory and Windows the per-user local application data folder.
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

function systemDataRoot({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "NIR");
  const base = env.XDG_DATA_HOME?.startsWith("/") ? env.XDG_DATA_HOME : join(home, ".local", "share");
  return join(base, "nir");
}

export function walletStorageRoot(options = {}) {
  const { platform = process.platform, home = homedir() } = options;
  if (platform === "darwin") return join(home, "Library", "Application Support", "NIR Wallet");
  return join(systemDataRoot(options), platform === "win32" ? "Wallet" : "wallet");
}

export function miningDataDirectory(options = {}) {
  const { platform = process.platform, env = process.env, home = homedir() } = options;
  if (env.NIR_MODEL_LAB_DATA) return env.NIR_MODEL_LAB_DATA;
  if (platform === "darwin") return join(home, "Library", "Application Support", "NIR Model Lab", "mining");
  return join(systemDataRoot(options), platform === "win32" ? "Miner" : "miner");
}

// The private browser profile the app windows open in: no extensions, no
// history shared with the person's everyday browser.
export function appWindowProfile(options = {}) {
  const { platform = process.platform } = options;
  return join(systemDataRoot(options), platform === "win32" ? "Window" : "window");
}
