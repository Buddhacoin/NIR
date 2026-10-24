import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { createProofAnswerCommit, createProofAnswerReveal, createTransfer, formatNir } from "./chain.mjs";
import { createMinerNodeClient, mineOneCliqueTask } from "./clique-miner.mjs";
import { cliqueSearchParameters } from "./clique-search.mjs";
import { ATOMIC_UNITS, MIN_TRANSFER_FEE } from "./constants.mjs";
import { generateWallet } from "./crypto.mjs";
import { acquireDataDirectoryLock } from "./data-directory-lock.mjs";
import { createDeveloperNodeHttpServer } from "./node-service.mjs";
import { initializeDevnet, LATEST_DEVNET_PROTOCOL_VERSION, PersistentDevNode } from "./node-store.mjs";
import { createNetworkRelay } from "./network-relay.mjs";
import { PROOF_MINING_V1 } from "./proof-mining-state.mjs";
import { verifySharedGenesis } from "./shared-network.mjs";

// One-button mining for an app (docs/proof-mining.md): a valueless local
// devnet with proof mining runs inside the app, a small miner key pays fees
// and answer bonds, and rewards go to the linked NIR Wallet address, so the
// wallet's own key never leaves the wallet.
//
// The miner key is a plain local file: it only ever holds devnet faucet
// coins for fees and bonds, never rewards unless no wallet is linked.

const MAX_EVENTS = 40;
// Kept on the miner key when its coins are sent to the wallet: room for a
// few more commits.
const MINER_RESERVE = 10n * (PROOF_MINING_V1.commitBond + 2n * MIN_TRANSFER_FEE);

// 210,000 NIR are shared by points at the main network's launch; this is
// today's share, which moves as everyone keeps mining.
const PIONEER_POOL = 210_000n * ATOMIC_UNITS;
export function pioneerView({ address, points, pioneers, totalPoints }) {
  const shareOf = (scale) => totalPoints > 0n ? points * scale / totalPoints : 0n;
  return { address, estimate: formatNir(shareOf(PIONEER_POOL)), pioneers, points: formatNir(points),
    // Hundredths of a percent.
    shareBasisPoints: Number(shareOf(10_000n)) };
}

export class CliqueMiningSession {
  #dataDirectory;
  #recipient;
  #httpPort;
  #tickMs;
  #retryMs;
  #node = null;
  #server = null;
  #timer = null;
  #releaseLock = null;
  #miner = null;
  #worker = null;
  #running = false;
  #state = "idle";
  #task = null;
  #search = null;
  #found = 0;
  #visited = 0;
  #lastClique = null;
  #events = [];
  #loop = null;
  // The shared test network (docs/shared-testnet.md), or null for the
  // practice network on this Mac.
  #network;
  #remote = null;
  #remoteView = null;
  #remoteBalances = new Map();
  #preparing = null;
  // Pioneer points of the rewarded address on the shared network
  // (docs/pioneer-program.md), refreshed every half minute.
  #pioneer = null;
  #pioneerAt = 0;

  // `recipient` returns the linked wallet address, or null.
  constructor({ dataDirectory, recipient = () => null, httpPort = 8787, tickMs = 2_000, network = null,
    retryMs = 5_000 }) {
    this.#dataDirectory = dataDirectory;
    this.#recipient = recipient;
    this.#httpPort = httpPort;
    this.#tickMs = tickMs;
    this.#retryMs = retryMs;
    this.#network = network;
  }

  get networkMode() { return this.#network ? "shared" : "local"; }

  // Events carry a kind and data, not prose, so the app can show them in its
  // own language.
  #event(kind, data = {}) {
    this.#events.push({ at: Date.now(), kind, ...data });
    if (this.#events.length > MAX_EVENTS) this.#events.shift();
  }

  // NIR Wallet reads which network the miner uses (miner-network-trust.mjs).
  #writeActiveNetwork(value) {
    const path = join(this.#dataDirectory, "active-network.json");
    writeFileSync(`${path}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  #loadMinerKey() {
    const keyPath = join(this.#dataDirectory, "miner-key.json");
    if (!existsSync(keyPath)) {
      writeFileSync(keyPath, `${JSON.stringify(generateWallet())}\n`, { flag: "wx", mode: 0o600 });
    }
    this.#miner = JSON.parse(readFileSync(keyPath, "utf8"));
  }

  async #prepare() {
    if (this.#network) {
      this.#preparing ??= this.#prepareShared().catch((error) => {
        this.#preparing = null;
        const last = this.#events.at(-1);
        if (last?.kind !== "network-error" || last.message !== error.message) {
          this.#event("network-error", { message: error.message });
        }
        throw error;
      });
      return this.#preparing;
    }
    return this.#prepareLocal();
  }

  // Joins the shared network: checks its genesis against the pinned hash,
  // funds the miner key once from its faucet, and relays NIR Wallet's
  // requests from 127.0.0.1 to it.
  async #prepareShared() {
    if (this.#remote) return;
    mkdirSync(join(this.#dataDirectory, "shared"), { recursive: true, mode: 0o700 });
    const base = this.#network.url;
    const response = await fetch(new URL("/v1/genesis", base), { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("the shared network did not answer");
    const genesis = await response.json();
    verifySharedGenesis(genesis, this.#network);
    const genesisPath = join(this.#dataDirectory, "shared", "genesis.json");
    writeFileSync(`${genesisPath}.tmp`, `${JSON.stringify(genesis)}\n`, { mode: 0o600 });
    renameSync(`${genesisPath}.tmp`, genesisPath);
    this.#writeActiveNetwork({ mode: "shared", networkId: this.#network.networkId });
    const client = createMinerNodeClient(base, { timeoutMs: 20_000 });
    this.#loadMinerKey();
    const account = await client.account(this.#miner.address);
    if (account.history.count === 0) {
      const faucet = await fetch(new URL("/v1/faucet", base), { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ recipient: this.#miner.address }),
        signal: AbortSignal.timeout(20_000) });
      if (faucet.ok) this.#event("faucet");
    }
    this.#remote = client;
    if (this.#httpPort !== null) {
      this.#server = createNetworkRelay(base);
      this.#server.on("error", () => { this.#server = null; });
      this.#server.listen(this.#httpPort, "127.0.0.1");
    }
    await this.#refreshShared();
    this.#timer = setInterval(() => { void this.#refreshShared(); }, 3_000);
    this.#timer.unref?.();
    this.#event("network-ready", { height: this.#remoteView?.height ?? 0, shared: true });
  }

  // status() answers at once, so shared-network figures are refreshed here.
  async #refreshShared() {
    try {
      const view = await this.#remote.proofMining();
      const balances = new Map();
      for (const address of [this.#miner.address, this.#recipient()].filter(Boolean)) {
        balances.set(address, BigInt((await this.#remote.account(address)).atomicBalance));
      }
      this.#remoteView = view;
      this.#remoteBalances = balances;
    } catch {}
    const rewarded = this.#recipient() ?? this.#miner?.address;
    if (!rewarded || (this.#pioneer?.address === rewarded && Date.now() - this.#pioneerAt < 30_000)) return;
    try {
      const response = await fetch(new URL(`/v1/pioneers/${rewarded}`, this.#network.url),
        { signal: AbortSignal.timeout(10_000) });
      const value = await response.json();
      if (!response.ok || value.address !== rewarded || !/^[0-9]{1,30}$/.test(value.points ?? "") ||
          !/^[0-9]{1,30}$/.test(value.totalPoints ?? "") || !Number.isSafeInteger(value.pioneers)) return;
      this.#pioneer = { address: rewarded, points: BigInt(value.points), pioneers: value.pioneers,
        totalPoints: BigInt(value.totalPoints) };
      this.#pioneerAt = Date.now();
    } catch {}
  }

  // Creates the devnet on first use (about 20 s), opens it, and funds the
  // miner key from the devnet faucet.
  #prepareLocal() {
    if (this.#node) return;
    mkdirSync(this.#dataDirectory, { recursive: true, mode: 0o700 });
    this.#writeActiveNetwork({ mode: "local" });
    const directory = join(this.#dataDirectory, "devnet");
    if (!existsSync(directory)) {
      this.#event("network-create");
      initializeDevnet(directory, { proofMining: true });
    }
    this.#releaseLock = acquireDataDirectoryLock(directory);
    this.#node = new PersistentDevNode(directory);
    // A network made by an earlier version moves to the current protocol.
    if (this.#node.proofMiningEnabled && this.#node.protocolVersion < LATEST_DEVNET_PROTOCOL_VERSION) {
      this.#event("network-upgrade");
      this.#node.upgradeTo(LATEST_DEVNET_PROTOCOL_VERSION);
    }
    // Blocks are made only while something needs them: an idle network that
    // added a block every tick grew by tens of thousands of blocks a day, and
    // every start of the miner and the wallet had to check them all.
    this.#timer = setInterval(() => {
      if (!this.#running && !this.#node.hasPendingWork) return;
      try { this.#node.tick(); } catch (error) { this.#event("network-error", { message: error.message }); }
    }, this.#tickMs);
    this.#timer.unref?.();
    if (this.#httpPort !== null) {
      // Lets NIR Wallet and command-line tools read this devnet.
      this.#server = createDeveloperNodeHttpServer(this.#node);
      this.#server.on("error", () => { this.#server = null; });
      this.#server.listen(this.#httpPort, "127.0.0.1");
    }
    this.#loadMinerKey();
    if (this.#node.account(this.#miner.address).history.count === 0) {
      this.#node.faucet(this.#miner.address);
      this.#event("faucet");
    }
    this.#event("network-ready", { height: this.#node.height });
  }

  #client() {
    if (this.#remote) return this.#remote;
    const node = this.#node;
    return {
      account: async (address) => node.account(address),
      health: async () => ({ height: node.height, networkId: node.networkId }),
      proofMining: async () => node.proofMining(),
      submit: async (transaction) => node.submitTransaction(transaction),
    };
  }

  #sign(operation) {
    const common = { chainIdentityGenesisHash: operation.chainIdentityGenesisHash,
      commitment: operation.commitment, networkId: operation.networkId,
      nonce: operation.nonce, wallet: this.#miner };
    return operation.type === "proof-answer-commit"
      ? createProofAnswerCommit({ ...common, taskRound: operation.taskRound })
      : createProofAnswerReveal({ ...common, recipient: operation.recipient, salt: operation.salt,
        vertices: operation.vertices });
  }

  #solveInWorker(input) {
    return new Promise((resolve, reject) => {
      const { shouldStop: _ignored, ...data } = input;
      const worker = new Worker(new URL("./clique-miner-worker.mjs", import.meta.url), { workerData: data });
      this.#worker = worker;
      let counted = 0;
      worker.on("message", (message) => {
        if (message.progress) {
          this.#visited += message.progress.visited - counted;
          counted = message.progress.visited;
          this.#search = { ...this.#search, ...message.progress };
        }
        if ("answer" in message) resolve(message.answer);
      });
      worker.on("error", reject);
      worker.on("exit", () => {
        if (this.#worker === worker) this.#worker = null;
        resolve(null);
      });
    });
  }

  // Opens the local network without mining, so NIR Wallet can read balances
  // whenever the miner app is open.
  async open() {
    await this.#prepare();
    return this.status();
  }

  start() {
    if (this.#running) return this.status();
    this.#running = true;
    this.#state = "preparing";
    this.#loop = (async () => {
      try {
        while (this.#running) {
          // A lost connection or a refused answer does not stop mining: the
          // miner says what happened and tries again.
          try {
            await this.#prepare();
            this.#state = "waiting";
            const recipient = this.#recipient() ?? this.#miner.address;
            const outcome = await mineOneCliqueTask({
              address: this.#miner.address, client: this.#client(), pollMs: 250, recipient,
              onTask: (task) => {
                this.#event("task", { level: task.level, round: task.round });
                this.#task = { ...task, ...cliqueSearchParameters(task.level) };
                this.#search = { deepest: 0, startedAt: Date.now(), visited: 0 };
                this.#state = "searching";
              },
              shouldStop: () => !this.#running,
              sign: (operation) => {
                this.#state = operation.type === "proof-answer-commit" ? "committing" : "revealing";
                if (operation.type === "proof-answer-commit") {
                  this.#event("found", { k: this.#task.k, ms: Date.now() - this.#search.startedAt,
                    round: this.#task.round });
                }
                return this.#sign(operation);
              },
              solve: (input) => this.#solveInWorker(input),
            });
            if (outcome.result === "revealed") {
              this.#found += 1;
              this.#lastClique = { n: this.#task.n, round: outcome.task.round, vertices: outcome.answer.vertices };
              this.#event("revealed", { round: outcome.task.round });
            }
            if (outcome.result !== "revealed") await new Promise((resolve) => setTimeout(resolve, 500));
          } catch (error) {
            if (!this.#running) break;
            this.#state = "preparing";
            const last = this.#events.at(-1);
            if (!["error", "network-error"].includes(last?.kind) || last.message !== error.message) {
              this.#event("error", { message: error.message });
            }
            for (let waited = 0; waited < this.#retryMs && this.#running; waited += 250) {
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          }
        }
      } finally {
        this.#running = false;
        this.#state = "idle";
      }
    })();
    return this.status();
  }

  async stop() {
    this.#running = false;
    await this.#worker?.terminate();
    await this.#loop;
    return this.status();
  }

  // Sends the miner key's coins, above a small reserve, to the linked wallet.
  async withdraw() {
    const recipient = this.#recipient();
    const client = this.#client();
    if ((!this.#node && !this.#remote) || !recipient) throw new Error("no linked wallet");
    const account = await client.account(this.#miner.address);
    const amount = BigInt(account.atomicBalance) - MINER_RESERVE - MIN_TRANSFER_FEE;
    if (amount <= 0n) throw new Error("nothing to send above the miner reserve");
    const view = await client.proofMining();
    const health = await client.health();
    const result = await client.submit(createTransfer({ amount: amount.toString(),
      chainIdentityGenesisHash: view.chainIdentityGenesisHash,
      networkId: health.networkId, nonce: account.nextNonce,
      recipient, wallet: this.#miner }));
    this.#event("withdraw", { amount: formatNir(amount) });
    return { amount: amount.toString(), ...result };
  }

  status() {
    const node = this.#node;
    const view = this.#remote ? this.#remoteView : node?.proofMining() ?? null;
    const recipient = this.#recipient();
    const balanceOf = (address) => (!address ? 0n : this.#remote ? this.#remoteBalances.get(address) ?? 0n
      : node ? BigInt(node.account(address).atomicBalance) : 0n);
    return {
      networkMode: this.networkMode,
      events: [...this.#events],
      found: this.#found,
      lastClique: this.#lastClique,
      miner: this.#miner ? { address: this.#miner.address, balance: formatNir(balanceOf(this.#miner.address)),
        // Rewards go straight to the wallet; only what the miner key holds
        // beyond its working reserve can be sent.
        canSend: balanceOf(this.#miner.address) > MINER_RESERVE + MIN_TRANSFER_FEE } : null,
      network: view ? { height: view.height, level: view.level, openTasks: view.openTasks.length,
        pendingRewards: view.pendingRewards, walletPort: this.#server ? this.#httpPort : null } : null,
      running: this.#running,
      search: this.#state === "searching" ? this.#search : null,
      visited: this.#visited,
      state: this.#state,
      task: this.#task ? { k: this.#task.k, level: this.#task.level, n: this.#task.n, round: this.#task.round } : null,
      wallet: recipient ? { address: recipient, balance: formatNir(balanceOf(recipient)) } : null,
      pioneer: this.#remote && this.#pioneer ? pioneerView(this.#pioneer) : null,
    };
  }

  async close() {
    await this.stop();
    clearInterval(this.#timer);
    await new Promise((resolve) => (this.#server ? this.#server.close(resolve) : resolve()));
    this.#releaseLock?.();
    this.#node = null;
  }
}
