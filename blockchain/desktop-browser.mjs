// Windows and Linux show NIR in app windows of a Chromium-family browser
// (Edge ships with Windows; Chrome, Chromium, Brave or Vivaldi elsewhere).
// Every window opens in NIR's own private profile: no extensions, no
// bookmarks, nothing shared with the person's everyday browsing. Without such
// a browser the default one opens the page instead.
import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import process from "node:process";

const LINUX_BROWSERS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
  "microsoft-edge", "microsoft-edge-stable", "brave-browser", "vivaldi-stable", "vivaldi"];

function executable(path) {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

export function findAppBrowser({ platform = process.platform, env = process.env, exists = executable } = {}) {
  if (env.NIR_BROWSER) return exists(env.NIR_BROWSER) ? env.NIR_BROWSER : null;
  if (platform === "win32") {
    const roots = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
    const candidates = roots.flatMap((root) => [
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ]);
    return candidates.find((path) => exists(path)) ?? null;
  }
  const directories = (env.PATH ?? "").split(delimiter).filter((directory) => directory.startsWith("/"));
  for (const name of LINUX_BROWSERS) {
    for (const directory of directories) {
      const path = join(directory, name);
      if (exists(path)) return path;
    }
  }
  return null;
}

export function appWindowArguments({ url, profile, width = 1180, height = 820 }) {
  return [`--app=${url}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
    "--disable-features=Translate,MediaRouter", "--password-store=basic"];
}

// Opens one window. The first window starts the profile's browser process;
// the returned child exits when the last NIR window closes. Later windows
// are handed to that process and their own launcher exits at once.
export function openAppWindow({ browser, profile, url, width, height, platform = process.platform }) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) throw new Error("app windows open only local NIR pages");
  if (browser) {
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    return spawn(browser, appWindowArguments({ url, profile, width, height }),
      { stdio: "ignore", windowsHide: false });
  }
  // The default browser: on Windows through the URL handler, so the address
  // is never parsed by a command shell.
  const child = platform === "win32"
    ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { stdio: "ignore" })
    : spawn("xdg-open", [url], { stdio: "ignore" });
  child.on("error", () => {});
  return null;
}
