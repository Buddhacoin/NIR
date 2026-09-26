const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export function validateLoopbackListener({ host, label = "node listener", port }) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 ||
      typeof host !== "string" || !LOOPBACK_HOSTS.has(host)) {
    throw new Error(`${label} requires a valid port and an explicit loopback host`);
  }
  return { host, port };
}

export function listenOnLoopback(server, {
  host, inheritedFd = null, label = "service listener", port,
}) {
  validateLoopbackListener({ host, label, port });
  if (!server || typeof server.listen !== "function" || typeof server.once !== "function") {
    throw new Error(`${label} server is invalid`);
  }
  if (inheritedFd !== null &&
      (!Number.isSafeInteger(inheritedFd) || inheritedFd < 3 || inheritedFd > 255)) {
    throw new Error(`${label} inherited descriptor is invalid`);
  }
  return new Promise((resolve, reject) => {
    const failed = () => {
      server.off("listening", listening);
      reject(new Error(`${label} is unavailable`));
    };
    const listening = () => {
      server.off("error", failed);
      const address = server.address();
      if (!address || typeof address === "string" || address.port !== port || address.address !== host) {
        server.close();
        reject(new Error(`${label} inherited binding is invalid`));
        return;
      }
      resolve(server);
    };
    server.once("error", failed);
    server.once("listening", listening);
    if (inheritedFd === null) server.listen(port, host);
    else server.listen({ fd: inheritedFd });
  });
}
