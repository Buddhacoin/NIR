// NIR Markets' own store of wallet transfers, so a wallet's links (the bubbles, /visualizer/) come at
// once and reach further back than one explorer page: every transfer the service reads (a wallet's
// pages, the live feed, the crawler's deeper pages) is kept in SQLite by its id, and a wallet's links
// are read back from there with one indexed query. The oldest rows go once the store passes `cap`.
//
// store(items) → how many were new; rows(address, limit) → the wallet's transfers, newest first;
// crawled(address, chain) / markCrawled(address, chain, cursor, done) → how far the crawler got.
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

const lower = (value) => String(value ?? "").toLowerCase();

export function createLedger({ file = ":memory:", now = Date.now, cap = 3_000_000 } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, chain TEXT NOT NULL, time INTEGER NOT NULL,
      sender TEXT NOT NULL, receiver TEXT NOT NULL, symbol TEXT, amount REAL, usd REAL);
    CREATE INDEX IF NOT EXISTS transfers_sender ON transfers (sender, time);
    CREATE INDEX IF NOT EXISTS transfers_receiver ON transfers (receiver, time);
    CREATE INDEX IF NOT EXISTS transfers_time ON transfers (time);
    CREATE TABLE IF NOT EXISTS crawls (address TEXT NOT NULL, chain TEXT NOT NULL, head_at INTEGER NOT NULL DEFAULT 0,
      cursor TEXT, done INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (address, chain));`);
  const insert = db.prepare("INSERT OR IGNORE INTO transfers (id, chain, time, sender, receiver, symbol, amount, usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const bySide = (side) => db.prepare(`SELECT id, chain, time, sender, receiver, symbol, amount, usd FROM transfers WHERE ${side} = ? ORDER BY time DESC LIMIT ?`);
  const sent = bySide("sender");
  const received = bySide("receiver");
  const count = db.prepare("SELECT COUNT(*) AS n FROM transfers");
  const prune = db.prepare("DELETE FROM transfers WHERE rowid IN (SELECT rowid FROM transfers ORDER BY time LIMIT ?)");
  const readCrawl = db.prepare("SELECT head_at, cursor, done, pages FROM crawls WHERE address = ? AND chain = ?");
  const writeCrawl = db.prepare(`INSERT INTO crawls (address, chain, head_at, cursor, done, pages) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (address, chain) DO UPDATE SET head_at = excluded.head_at, cursor = excluded.cursor, done = excluded.done, pages = excluded.pages`);
  let added = 0;

  function store(items) {
    let fresh = 0;
    db.exec("BEGIN");
    try {
      for (const item of items ?? []) {
        const from = lower(item?.from?.address);
        const to = lower(item?.to?.address);
        if (!item?.id || !from || !to || !Number.isFinite(item.time)) continue;
        fresh += Number(insert.run(item.id, item.chain, item.time, from, to, item.token?.symbol ?? null,
          Number.isFinite(item.amount) ? item.amount : null, Number.isFinite(item.usd) ? item.usd : null).changes);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    added += fresh;
    // Now and then the oldest rows make room, so the store stays within its size.
    if (added > 50_000) {
      added = 0;
      const over = Number(count.get().n) - cap;
      if (over > 0) prune.run(over);
    }
    return fresh;
  }
  // The wallet's transfers both ways, newest first, as the pages show them.
  function rows(address, limit = 5_000) {
    const key = lower(address);
    const both = [...sent.all(key, limit), ...received.all(key, limit)];
    const seen = new Set();
    return both.filter((row) => !seen.has(row.id) && seen.add(row.id)).sort((left, right) => right.time - left.time).slice(0, limit)
      .map((row) => ({ id: row.id, chain: row.chain, time: row.time, from: row.sender, to: row.receiver, symbol: row.symbol, amount: row.amount, usd: row.usd }));
  }
  function crawled(address, chain) {
    const row = readCrawl.get(lower(address), chain);
    return row ? { headAt: Number(row.head_at), cursor: row.cursor ? JSON.parse(row.cursor) : null, done: Boolean(row.done), pages: Number(row.pages) } : null;
  }
  function markCrawled(address, chain, { headAt, cursor, done, pages }) {
    writeCrawl.run(lower(address), chain, headAt ?? now(), cursor ? JSON.stringify(cursor) : null, done ? 1 : 0, pages ?? 0);
  }
  const size = () => Number(count.get().n);
  // Wallets that sent at least `least` transfers since `since`, every one of them to the same wallet: the
  // pattern of an exchange's deposit addresses, which pass everything on to its hot wallet.
  const forwarders = db.prepare(`SELECT sender, MIN(receiver) AS receiver, COUNT(*) AS n FROM transfers WHERE time > ?
    GROUP BY sender HAVING COUNT(DISTINCT receiver) = 1 AND COUNT(*) >= ? LIMIT ?`);
  const singleReceivers = (since = 0, least = 2, limit = 200_000) => forwarders.all(since, least, limit)
    .map((row) => ({ sender: row.sender, receiver: row.receiver, count: Number(row.n) }));
  // How many transfers a wallet sent since a time (a hot wallet pays out about as often as it takes in).
  const sentSince = db.prepare("SELECT COUNT(*) AS n FROM transfers WHERE sender = ? AND time > ?");
  const sentCount = (address, since = 0) => Number(sentSince.get(address, since)?.n ?? 0);
  // The wallets the most money moved through since a time (sent and received, in dollars): the whales.
  const busiestSince = db.prepare(`SELECT address, SUM(usd) AS usd, COUNT(*) AS n FROM (
      SELECT sender AS address, usd FROM transfers WHERE time > ? AND usd IS NOT NULL
      UNION ALL SELECT receiver AS address, usd FROM transfers WHERE time > ? AND usd IS NOT NULL)
    GROUP BY address ORDER BY usd DESC LIMIT ?`);
  const busiest = (since = 0, limit = 100) => busiestSince.all(since, since, limit).map((row) => ({ address: row.address, usd: Number(row.usd), transfers: Number(row.n) }));
  // The same count off the main thread (a store in a file); an in-memory store counts here.
  const busiestLater = (since = 0, limit = 100) => (file === ":memory:" ? Promise.resolve(busiest(since, limit)) : new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./market-ledger-busiest.mjs", import.meta.url), { workerData: { file, since, limit } });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => { if (code) reject(new Error(`busiest worker exited ${code}`)); });
  }));
  return { store, rows, crawled, markCrawled, size, singleReceivers, sent: sentCount, busiest, busiestLater, close: () => db.close() };
}
