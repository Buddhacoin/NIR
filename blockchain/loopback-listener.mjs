const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export function validateLoopbackListener({ host, label = "node listener", port }) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 ||
      typeof host !== "string" || !LOOPBACK_HOSTS.has(host)) {
    throw new Error(`${label} requires a valid port and an explicit loopback host`);
  }
  return { host, port };
}
