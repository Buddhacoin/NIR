// The shared NIR test network (docs/shared-testnet.md): one host runs the
// proof-mining devnet that every NIR Майнер and NIR Wallet connects to, so
// people can mine against each other, send NIR and use names. It is a
// developer test network: all four validator keys live on this host, NIR
// here has no value, and the network may be reset. Splitting the validators
// across independent hosts is a later step (docs/public-testnet-gates.md).
import { createNodeHttpServer } from "./node-service.mjs";
import { initializeDevnet, PersistentDevNode } from "./node-store.mjs";

export const SHARED_TESTNET_ID = "nir-shared-testnet-1";

export function initializeSharedTestnet(directory, { networkId = SHARED_TESTNET_ID, proofMiningInitialLevel = 32 } = {}) {
  const created = initializeDevnet(directory, { networkId, proofMining: true, proofMiningInitialLevel });
  const node = new PersistentDevNode(directory);
  return { ...created, genesisHash: node.proofMining().chainIdentityGenesisHash };
}

// A fixed faucet amount per fresh address (enforced by the node), at most
// `perClient` requests per client a day and `perHour` in total.
export function createFaucetLimit({ perClient = 3, perHour = 120, trustProxy = false, now = () => Date.now() } = {}) {
  const clients = new Map();
  const recent = [];
  return (request) => {
    const time = now();
    const forwarded = trustProxy ? String(request.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    const client = forwarded || request.socket?.remoteAddress || "unknown";
    while (recent.length > 0 && recent[0] < time - 3_600_000) recent.shift();
    const history = (clients.get(client) ?? []).filter((at) => at > time - 86_400_000);
    if (recent.length >= perHour || history.length >= perClient) {
      throw new Error("faucet rate limit reached; try again later");
    }
    recent.push(time);
    history.push(time);
    clients.set(client, history);
    if (clients.size > 100_000) clients.delete(clients.keys().next().value);
  };
}

// Blocks are made only while they are useful: while miners are asking for
// tasks, or while answers, rewards or names still need blocks.
export function startSharedTestnet({ directory, port = 8787, host = "127.0.0.1", tickMs = 2_000,
  minerIdleMs = 60_000, trustProxy = false, faucetLimit = createFaucetLimit({ trustProxy }) } = {}) {
  const node = new PersistentDevNode(directory);
  let lastMinerPoll = 0;
  const served = new Proxy(node, {
    get(target, property) {
      if (property === "proofMining") {
        return () => { lastMinerPoll = Date.now(); return target.proofMining(); };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const server = createNodeHttpServer(served, { rpcProfile: "shared-testnet", faucetLimit });
  const timer = setInterval(() => {
    if (!node.hasPendingWork && Date.now() - lastMinerPoll > minerIdleMs) return;
    try { node.tick(); } catch (error) { console.error(`tick failed: ${error.message}`); }
  }, tickMs);
  timer.unref?.();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve({
      node, server,
      close: () => new Promise((done) => { clearInterval(timer); server.closeAllConnections?.(); server.close(done); }),
    }));
  });
}
