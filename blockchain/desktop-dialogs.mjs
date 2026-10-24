// The windows where Windows and Linux ask for a wallet password, show the 24
// words or confirm a signature — what a Mac does in its own system windows.
// They are served from a separate loopback origin with a one-time token per
// window, so the wallet page itself never receives a password or the words.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const ASSETS = new Map([
  ["/dialog", ["dialog.html", "text/html; charset=utf-8"]],
  ["/dialog.js", ["dialog.js", "text/javascript; charset=utf-8"]],
  ["/dialog.css", ["dialog.css", "text/css; charset=utf-8"]],
  ["/icon.svg", ["../site/nir-coin-icon.svg", "image/svg+xml"]],
]);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MAX_BODY = 16 * 1024;
const OPEN_TIMEOUT_MS = 90_000;   // the window has to appear within this time
const ALIVE_TIMEOUT_MS = 8_000;   // an open window checks in every two seconds

function sameToken(supplied, expected) {
  return typeof supplied === "string" && /^[0-9a-f]{64}$/.test(supplied) &&
    timingSafeEqual(Buffer.from(supplied, "hex"), expected);
}

function validSpec(spec) {
  const text = (value, max) => typeof value === "string" && value.length <= max;
  return spec && text(spec.title, 200) && text(spec.message ?? "", 4000) && text(spec.error ?? "", 500) &&
    [undefined, "ru", "en"].includes(spec.language) &&
    Array.isArray(spec.buttons) && spec.buttons.length >= 1 && spec.buttons.length <= 3 &&
    spec.buttons.every((button) => text(button.id, 40) && text(button.label, 80)) &&
    (spec.words === undefined || (Array.isArray(spec.words) && spec.words.length <= 24 &&
      spec.words.every((word) => text(word, 20)))) &&
    (spec.fields ?? []).length <= 4 && (spec.fields ?? []).every((field) =>
      text(field.name, 40) && text(field.label, 300) && ["text", "password", "words"].includes(field.type));
}

// ask(spec) resolves with { button, values } or null when the person closes
// the window, it never appears, or the caller's signal aborts.
export function createDialogHost({ openWindow, assetRoot = new URL("../desktop-ui/", import.meta.url),
  openTimeoutMs = OPEN_TIMEOUT_MS, aliveTimeoutMs = ALIVE_TIMEOUT_MS }) {
  const files = new Map([...ASSETS].map(([path, [file, type]]) =>
    [path, [readFileSync(new URL(file, assetRoot)), type]]));
  const dialogs = new Map();
  let control = null;
  const server = createServer((request, response) => {
    const port = server.address()?.port;
    const send = (status, type, body) => {
      response.writeHead(status, { "cache-control": "no-store", "content-security-policy": CSP,
        "content-type": type, "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
        "x-frame-options": "DENY", "cross-origin-opener-policy": "same-origin" });
      response.end(body);
    };
    if (request.headers.host !== `127.0.0.1:${port}`) return send(421, "text/plain", "");
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (request.method === "GET" && files.has(path)) return send(200, files.get(path)[1], files.get(path)[0]);
    // A second start of NIR asks this one to show its windows again.
    if (request.method === "POST" && path === "/reopen" && control &&
        sameToken(request.headers["x-nir-control"], control.token)) {
      send(204, "text/plain", "");
      return control.reopen();
    }
    if (request.method !== "POST" || request.headers.origin !== `http://127.0.0.1:${port}` ||
        !["/dialog/state", "/dialog/answer", "/dialog/alive"].includes(path)) {
      return send(404, "text/plain", "");
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) request.destroy();
    });
    request.on("end", () => {
      let message;
      try { message = JSON.parse(body); } catch { return send(400, "application/json", "{}"); }
      const dialog = dialogs.get(message?.id);
      if (!dialog || !sameToken(request.headers["x-nir-dialog"], dialog.token)) {
        return send(403, "application/json", JSON.stringify({ closed: true }));
      }
      dialog.lastSeen = Date.now();
      if (path === "/dialog/state") {
        dialog.opened = true;
        return send(200, "application/json", JSON.stringify(dialog.spec));
      }
      if (path === "/dialog/alive") return send(200, "application/json", "{}");
      const button = dialog.spec.buttons.find(({ id }) => id === message.button)?.id;
      const values = {};
      for (const field of dialog.spec.fields ?? []) {
        const value = message.values?.[field.name];
        values[field.name] = typeof value === "string" ? value.slice(0, 1000) : "";
      }
      if (!button) return send(400, "application/json", "{}");
      send(200, "application/json", "{}");
      dialog.finish({ button, values });
    });
  });
  const watcher = setInterval(() => {
    const now = Date.now();
    for (const dialog of dialogs.values()) {
      if (now - dialog.lastSeen > (dialog.opened ? aliveTimeoutMs : openTimeoutMs)) dialog.finish(null);
    }
  }, Math.min(1_000, aliveTimeoutMs / 2));
  watcher.unref();
  server.on("close", () => {
    clearInterval(watcher);
    for (const dialog of dialogs.values()) dialog.finish(null);
  });

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    }),
    ask(spec, { signal, width = 560, height = 560 } = {}) {
      if (!validSpec(spec)) throw new Error("dialog is invalid");
      if (signal?.aborted) return Promise.resolve(null);
      const id = randomBytes(16).toString("hex");
      const token = randomBytes(32);
      return new Promise((resolve) => {
        const dialog = { spec, token, lastSeen: Date.now(), opened: false, finish: (result) => {
          if (!dialogs.delete(id)) return;
          // The words leave memory with the dialog.
          if (spec.words) spec.words.fill("");
          signal?.removeEventListener("abort", abort);
          resolve(result);
        } };
        const abort = () => dialog.finish(null);
        signal?.addEventListener("abort", abort, { once: true });
        dialogs.set(id, dialog);
        const url = `http://127.0.0.1:${server.address().port}/dialog#${id}.${token.toString("hex")}`;
        try { openWindow(url, { width, height }); } catch { dialog.finish(null); }
      });
    },
    // Returns the token a second start presents to reopen the windows.
    allowReopen(reopen) {
      control = { reopen, token: randomBytes(32) };
      return control.token.toString("hex");
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
