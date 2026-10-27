// Satoshi Nakamoto's coins, as the analytics sites count them: the 21,953 early blocks whose mining
// pattern ("Patoshi", found by Sergio Demian Lerner; the list of their coinbase public keys is kept at
// github.com/RandyMcMillan/patoshi-addresses) each paid 50 coins to a key of their own, and most were
// never spent. The service reads the list once, then asks a public explorer about each key, one every
// `gap` milliseconds (about three hours for all, again a month later), and keeps the answers in SQLite.
// Until every key is read, the ones not read yet count as their 50 coins: almost none have moved.
//
// GET /market/chain/satoshi → { keys, checked, coins, unspent, moved, estimate, done, price }
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const PATOSHI_LIST = "https://raw.githubusercontent.com/RandyMcMillan/patoshi-addresses/main/patoshi_pubkeys_COMPLETE.csv";
const EXPLORER = "https://mempool.space/api/scripthash/";
const REWARD = 50 * 1e8; // a block's reward then, in the coin's smallest units
const PUBKEY = /^(?:04[0-9a-f]{128}|0[23][0-9a-f]{64})$/;

// The explorer's key for a pay-to-public-key output: the SHA-256 of its script (push, key, CHECKSIG).
export function scriptHash(pubkey) {
  const key = Buffer.from(pubkey, "hex");
  return createHash("sha256").update(Buffer.concat([Buffer.from([key.length]), key, Buffer.from([0xac])])).digest("hex");
}
// The list's rows: block height and public key (the first line names the columns).
export function readList(text) {
  const rows = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const [height, , key] = line.split(",");
    if (PUBKEY.test(key?.trim() ?? "") && /^\d+$/.test(height)) rows.push({ height: Number(height), pubkey: key.trim() });
  }
  return rows;
}

export function createPatoshi({ get, getText, file = ":memory:", now = Date.now, gap = 500, recheck = 30 * 86_400_000,
  price = () => null, wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }) } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS patoshi (pubkey TEXT PRIMARY KEY, height INTEGER NOT NULL, sats INTEGER, checked_at INTEGER NOT NULL DEFAULT 0);`);
  const count = () => Number(db.prepare("SELECT COUNT(*) AS n FROM patoshi").get().n);
  const insert = db.prepare("INSERT OR IGNORE INTO patoshi (pubkey, height) VALUES (?, ?)");
  const next = db.prepare("SELECT pubkey FROM patoshi WHERE checked_at < ? ORDER BY checked_at, height LIMIT 1");
  const update = db.prepare("UPDATE patoshi SET sats = ?, checked_at = ? WHERE pubkey = ?");
  let running = false;

  async function load() {
    if (count()) return true;
    const rows = readList(await getText(PATOSHI_LIST));
    if (rows.length < 1_000) return false;
    db.exec("BEGIN");
    for (const row of rows) insert.run(row.pubkey, row.height);
    db.exec("COMMIT");
    return true;
  }
  // One key: what is still unspent on it.
  async function check(pubkey) {
    const answer = await get(`${EXPLORER}${scriptHash(pubkey)}`);
    const stats = answer?.chain_stats;
    // A key the explorer knows nothing of is noted as read, with nothing on it.
    if (!stats) { update.run(null, now(), pubkey); return; }
    update.run(Number(stats.funded_txo_sum) - Number(stats.spent_txo_sum), now(), pubkey);
  }
  async function loop() {
    while (running) {
      try {
        if (!await load()) { await wait(3_600_000); continue; }
        const row = next.get(now() - recheck);
        if (!row) { await wait(3_600_000); continue; }
        await check(row.pubkey);
        await wait(gap);
      } catch {
        await wait(60_000); // the explorer is busy: a minute's pause
      }
    }
  }
  function start() {
    if (running) return () => {};
    running = true;
    void loop();
    return () => { running = false; };
  }
  function summary() {
    const row = db.prepare(`SELECT COUNT(*) AS keys, SUM(checked_at > 0) AS checked, COALESCE(SUM(CASE WHEN checked_at > 0 THEN sats END), 0) AS sats,
      SUM(checked_at > 0 AND sats > 0) AS unspent, SUM(checked_at > 0 AND sats < ?) AS moved FROM patoshi`).get(REWARD);
    const keys = Number(row.keys);
    const checked = Number(row.checked ?? 0);
    const coins = Number(row.sats) / 1e8;
    // Keys not read yet count as their untouched reward.
    const estimate = coins + (keys - checked) * (REWARD / 1e8);
    return { keys, checked, coins, unspent: Number(row.unspent ?? 0), moved: Number(row.moved ?? 0), estimate, done: keys > 0 && checked === keys, price: price() };
  }
  return { start, load, check, summary };
}
