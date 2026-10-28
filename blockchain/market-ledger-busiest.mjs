// The busiest wallets of the transfer store, counted in a thread of their own: over millions of rows the sum
// takes seconds, and the service must keep answering meanwhile. The thread opens the same file read-only
// (the store is in WAL mode, so it reads beside the writer), answers once and ends.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const { file, since, limit } = workerData;
const db = new DatabaseSync(file, { readOnly: true });
const rows = db.prepare(`SELECT address, SUM(usd) AS usd, COUNT(*) AS n FROM (
    SELECT sender AS address, usd FROM transfers WHERE time > ? AND usd IS NOT NULL
    UNION ALL SELECT receiver AS address, usd FROM transfers WHERE time > ? AND usd IS NOT NULL)
  GROUP BY address ORDER BY usd DESC LIMIT ?`).all(since, since, limit);
db.close();
parentPort.postMessage(rows.map((row) => ({ address: row.address, usd: Number(row.usd), transfers: Number(row.n) })));
