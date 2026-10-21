import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { createProofAnswerCommit, createProofAnswerReveal, createTransfer, formatNir } from "./chain.mjs";
import { mineOneCliqueTask } from "./clique-miner.mjs";
import { cliqueSearchParameters } from "./clique-search.mjs";
import { MIN_TRANSFER_FEE } from "./constants.mjs";
import { generateWallet } from "./crypto.mjs";
import { acquireDataDirectoryLock } from "./data-directory-lock.mjs";
import { createDeveloperNodeHttpServer } from "./node-service.mjs";
import { initializeDevnet, LATEST_DEVNET_PROTOCOL_VERSION, PersistentDevNode } from "./node-store.mjs";
import { PROOF_MINING_V1 } from "./proof-mining-state.mjs";

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

export class CliqueMiningSession {
  #dataDirectory;
  #recipient;
  #httpPort;
  #tickMs;
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

  // `recipient` returns the linked wallet address, or null.
  constructor({ dataDirectory, recipient = () => null, httpPort = 8787, tickMs = 2_000 }) {
    this.#dataDirectory = dataDirectory;
    this.#recipient = recipient;
    this.#httpPort = httpPort;
    this.#tickMs = tickMs;
  }

  // Events carry a kind and data, not prose, so the app can show them in its
  // own language.
  #event(kind, data = {}) {
    this.#events.push({ at: Date.now(), kind, ...data });
    if (this.#events.length > MAX_EVENTS) this.#events.shift();
  }

  // Creates the devnet on first use (about 20 s), opens it, and funds the
  // miner key from the devnet faucet.
  #prepare() {
    if (this.#node) return;
    mkdirSync(this.#dataDirectory, { recursive: true, mode: 0o700 });
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
    this.#timer = setInterval(() => {
      try { this.#node.tick(); } catch (error) { this.#event("network-error", { message: error.message }); }
    }, this.#tickMs);
    this.#timer.unref?.();
    if (this.#httpPort !== null) {
      // Lets NIR Wallet and command-line tools read this devnet.
      this.#server = createDeveloperNodeHttpServer(this.#node);
      this.#server.on("error", () => { this.#server = null; });
      this.#server.listen(this.#httpPort, "127.0.0.1");
    }
    const keyPath = join(this.#dataDirectory, "miner-key.json");
    if (!existsSync(keyPath)) {
      writeFileSync(keyPath, `${JSON.stringify(generateWallet())}\n`, { flag: "wx", mode: 0o600 });
    }
    this.#miner = JSON.parse(readFileSync(keyPath, "utf8"));
    if (this.#node.account(this.#miner.address).history.count === 0) {
      this.#node.faucet(this.#miner.address);
      this.#event("faucet");
    }
    this.#event("network-ready", { height: this.#node.height });
  }

  #client() {
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
  open() {
    this.#prepare();
    return this.status();
  }

  start() {
    if (this.#running) return this.status();
    this.#running = true;
    this.#state = "preparing";
    this.#loop = (async () => {
      try {
        this.#prepare();
        while (this.#running) {
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
        }
      } catch (error) {
        this.#event("error", { message: error.message });
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
  withdraw() {
    const recipient = this.#recipient();
    if (!this.#node || !recipient) throw new Error("no linked wallet");
    const balance = BigInt(this.#node.account(this.#miner.address).atomicBalance);
    const amount = balance - MINER_RESERVE - MIN_TRANSFER_FEE;
    if (amount <= 0n) throw new Error("nothing to send above the miner reserve");
    const result = this.#node.submitTransaction(createTransfer({ amount: amount.toString(),
      chainIdentityGenesisHash: this.#node.proofMining().chainIdentityGenesisHash,
      networkId: this.#node.networkId, nonce: this.#node.account(this.#miner.address).nextNonce,
      recipient, wallet: this.#miner }));
    this.#event("withdraw", { amount: formatNir(amount) });
    return { amount: amount.toString(), ...result };
  }

  status() {
    const node = this.#node;
    const view = node?.proofMining() ?? null;
    const recipient = this.#recipient();
    const balanceOf = (address) => (node && address ? BigInt(node.account(address).atomicBalance) : 0n);
    return {
      events: [...this.#events],
      found: this.#found,
      lastClique: this.#lastClique,
      miner: this.#miner ? { address: this.#miner.address, balance: formatNir(balanceOf(this.#miner.address)) } : null,
      network: view ? { height: view.height, level: view.level, openTasks: view.openTasks.length,
        pendingRewards: view.pendingRewards, walletPort: this.#server ? this.#httpPort : null } : null,
      running: this.#running,
      search: this.#state === "searching" ? this.#search : null,
      visited: this.#visited,
      state: this.#state,
      task: this.#task ? { k: this.#task.k, level: this.#task.level, n: this.#task.n, round: this.#task.round } : null,
      wallet: recipient ? { address: recipient, balance: formatNir(balanceOf(recipient)) } : null,
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
