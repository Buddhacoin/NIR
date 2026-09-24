const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export function validateLoopbackListener({ host, label = "node listener", port }) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 ||
      typeof host !== "string" || !LOOPBACK_HOSTS.has(host)) {
    throw new Error(`${label} requires a valid port and an explicit loopback host`);
  }
  return { host, port };
}

export function listenOnLoopback(server, { host, label = "service listener", port }) {
  validateLoopbackListener({ host, label, port });
  if (!server || typeof server.listen !== "function" || typeof server.once !== "function") {
    throw new Error(`${label} server is invalid`);
  }
  return new Promise((resolve, reject) => {
    const failed = () => {
      server.off("listening", listening);
      reject(new Error(`${label} is unavailable`));
    };
    const listening = () => {
      server.off("error", failed);
      resolve(server);
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(port, host);
  });
}
