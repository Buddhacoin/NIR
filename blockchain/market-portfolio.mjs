// NIR Markets portfolio: a signed-in visitor's buy and sell records, kept on
// the server so the portfolio follows them to any device. Part of the
// accounts service (market-accounts.mjs), sharing its database and checks.
//
// Records are private: no profile, activity feed or other visitor sees them.
// The page works out holdings, average buy price and profit from the records
// and the current prices; the server only stores and checks the records.
// Limits: 2,000 records per account; amounts and prices are positive finite
// numbers; dates from 2009 to a day ahead; a note of up to 200 characters.

const COIN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const KINDS = new Set(["buy", "sell"]);
const LIMIT = 2000;
const EARLIEST = Date.UTC(2009, 0, 1);
const DAY = 86_400_000;

export function createPortfolio({ db, now }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS portfolio (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, coin_id TEXT NOT NULL,
      kind TEXT NOT NULL, amount REAL NOT NULL, price REAL NOT NULL, fee REAL NOT NULL DEFAULT 0, at INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS portfolio_user ON portfolio (user_id, at);`);
  const sql = (text) => db.prepare(text);
  const list = (userId) => sql(`SELECT id, coin_id AS coinId, kind, amount, price, fee, at, note FROM portfolio
    WHERE user_id = ? ORDER BY at DESC, id DESC`).all(userId).map((row) => ({ ...row }));

  // A record from the page, checked field by field; returns [record] or [null, error].
  function check(input) {
    const record = {
      coinId: typeof input?.coinId === "string" ? input.coinId : "",
      kind: input?.kind,
      amount: Number(input?.amount),
      price: Number(input?.price),
      fee: input?.fee === undefined || input?.fee === "" ? 0 : Number(input?.fee),
      at: Number(input?.at),
      note: typeof input?.note === "string" ? input.note.trim() : "",
    };
    if (!COIN.test(record.coinId)) return [null, "unknown coin"];
    if (!KINDS.has(record.kind)) return [null, "kind must be buy or sell"];
    if (!Number.isFinite(record.amount) || record.amount <= 0 || record.amount > 1e15) return [null, "amount must be a positive number"];
    if (!Number.isFinite(record.price) || record.price < 0 || record.price > 1e12) return [null, "price must be zero or more"];
    if (!Number.isFinite(record.fee) || record.fee < 0 || record.fee > 1e12) return [null, "fee must be zero or more"];
    if (!Number.isInteger(record.at) || record.at < EARLIEST || record.at > now() + DAY) return [null, "date is out of range"];
    if ([...record.note].length > 200) return [null, "note must be at most 200 characters"];
    return [record];
  }
  const count = (userId) => sql("SELECT COUNT(*) AS n FROM portfolio WHERE user_id = ?").get(userId).n;
  const insert = (userId, record) => sql(`INSERT INTO portfolio (user_id, coin_id, kind, amount, price, fee, at, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, record.coinId, record.kind, record.amount, record.price, record.fee,
    record.at, record.note, now());

  // Answers /market/me/portfolio[/<id>] for a signed-in user, or returns false.
  async function handle({ method, path, user, request, response, json, body }) {
    if (path === "/market/me/portfolio" && method === "GET") return json(response, 200, { transactions: list(user.id) }), true;
    if (path === "/market/me/portfolio" && method === "POST") {
      // One record, or { transactions: [...] } kept in this browser before signing in.
      const input = await body(request);
      const batch = Array.isArray(input?.transactions) ? input.transactions : [input];
      const checked = batch.map(check);
      const bad = checked.find(([record]) => !record);
      if (bad) return json(response, 400, { error: bad[1] }), true;
      if (count(user.id) + checked.length > LIMIT) return json(response, 409, { error: "the portfolio is full" }), true;
      for (const [record] of checked) insert(user.id, record);
      return json(response, 201, { transactions: list(user.id) }), true;
    }
    const match = /^\/market\/me\/portfolio\/(\d{1,15})$/.exec(path);
    if (!match || (method !== "PUT" && method !== "DELETE")) return false;
    const id = Number(match[1]);
    if (!sql("SELECT 1 FROM portfolio WHERE id = ? AND user_id = ?").get(id, user.id)) return json(response, 404, { error: "no such record" }), true;
    if (method === "DELETE") sql("DELETE FROM portfolio WHERE id = ?").run(id);
    else {
      const [record, error] = check(await body(request));
      if (!record) return json(response, 400, { error }), true;
      sql("UPDATE portfolio SET coin_id = ?, kind = ?, amount = ?, price = ?, fee = ?, at = ?, note = ? WHERE id = ?")
        .run(record.coinId, record.kind, record.amount, record.price, record.fee, record.at, record.note, id);
    }
    return json(response, 200, { transactions: list(user.id) }), true;
  }

  const forget = (userId) => sql("DELETE FROM portfolio WHERE user_id = ?").run(userId);
  return { handle, forget };
}
