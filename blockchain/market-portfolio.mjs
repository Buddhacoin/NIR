// NIR Markets portfolios: a signed-in visitor's named portfolios ("folders")
// and their transactions, kept on the server so they follow the visitor to
// any device. Part of the accounts service (market-accounts.mjs), sharing its
// database and checks.
//
// A transaction is a buy, a sale, or a transfer in or out (coins kept in a
// wallet elsewhere, added or taken away without trading). Records are
// private: no profile, activity feed or other visitor sees them. The page
// works out holdings, average buy price and profit from the records and the
// prices; the server only stores and checks them.
//
// Limits: 20 portfolios with names of up to 40 characters, 2,000 records per
// account; amounts and prices are finite non-negative numbers (amounts above
// zero); dates from 2009 to a day ahead; a note of up to 200 characters.

const COIN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const KINDS = new Set(["buy", "sell", "in", "out"]);
const LIMIT = 2000;
const PORTFOLIOS = 20;
const EARLIEST = Date.UTC(2009, 0, 1);
const DAY = 86_400_000;

export function createPortfolio({ db, now }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS portfolio (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, coin_id TEXT NOT NULL,
      kind TEXT NOT NULL, amount REAL NOT NULL, price REAL NOT NULL, fee REAL NOT NULL DEFAULT 0, at INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS portfolio_user ON portfolio (user_id, at);
    CREATE TABLE IF NOT EXISTS portfolios (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL,
      created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS portfolios_user ON portfolios (user_id, id);`);
  // Records from before portfolios existed have no portfolio; they join the account's first one.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('portfolio') WHERE name = 'portfolio_id'").get()) {
    db.exec("ALTER TABLE portfolio ADD COLUMN portfolio_id INTEGER");
  }
  const sql = (text) => db.prepare(text);

  function adoptLoose(userId) {
    if (!sql("SELECT 1 FROM portfolio WHERE user_id = ? AND portfolio_id IS NULL").get(userId)) return;
    const first = sql("SELECT id FROM portfolios WHERE user_id = ? ORDER BY id LIMIT 1").get(userId)?.id
      ?? Number(sql("INSERT INTO portfolios (user_id, name, created_at) VALUES (?, ?, ?)").run(userId, "Мой портфель", now()).lastInsertRowid);
    sql("UPDATE portfolio SET portfolio_id = ? WHERE user_id = ? AND portfolio_id IS NULL").run(first, userId);
  }
  function state(userId) {
    adoptLoose(userId);
    return {
      portfolios: sql("SELECT id, name, created_at AS createdAt FROM portfolios WHERE user_id = ? ORDER BY id").all(userId).map((row) => ({ ...row })),
      transactions: sql(`SELECT id, portfolio_id AS portfolioId, coin_id AS coinId, kind, amount, price, fee, at, note FROM portfolio
        WHERE user_id = ? ORDER BY at DESC, id DESC`).all(userId).map((row) => ({ ...row })),
    };
  }
  const owns = (userId, portfolioId) => Boolean(Number.isInteger(portfolioId) && sql("SELECT 1 FROM portfolios WHERE id = ? AND user_id = ?").get(portfolioId, userId));

  // A record from the page, checked field by field; returns [record] or [null, error].
  function check(input) {
    const record = {
      coinId: typeof input?.coinId === "string" ? input.coinId : "",
      kind: input?.kind,
      amount: Number(input?.amount),
      price: input?.price === undefined || input?.price === "" ? 0 : Number(input?.price),
      fee: input?.fee === undefined || input?.fee === "" ? 0 : Number(input?.fee),
      at: Number(input?.at),
      note: typeof input?.note === "string" ? input.note.trim() : "",
    };
    if (!COIN.test(record.coinId)) return [null, "unknown coin"];
    if (!KINDS.has(record.kind)) return [null, "kind must be buy, sell, in or out"];
    if (!Number.isFinite(record.amount) || record.amount <= 0 || record.amount > 1e15) return [null, "amount must be a positive number"];
    if (!Number.isFinite(record.price) || record.price < 0 || record.price > 1e12) return [null, "price must be zero or more"];
    if (!Number.isFinite(record.fee) || record.fee < 0 || record.fee > 1e12) return [null, "fee must be zero or more"];
    if (!Number.isInteger(record.at) || record.at < EARLIEST || record.at > now() + DAY) return [null, "date is out of range"];
    if ([...record.note].length > 200) return [null, "note must be at most 200 characters"];
    return [record];
  }
  const name = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
  const count = (userId) => sql("SELECT COUNT(*) AS n FROM portfolio WHERE user_id = ?").get(userId).n;
  const insert = (userId, portfolioId, record) => sql(`INSERT INTO portfolio (user_id, portfolio_id, coin_id, kind, amount, price, fee, at, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, portfolioId, record.coinId, record.kind, record.amount, record.price, record.fee,
    record.at, record.note, now());
  // Checks a batch and answers [records] or [null, status, error].
  function batch(userId, list) {
    const checked = list.map(check);
    const bad = checked.find(([record]) => !record);
    if (bad) return [null, 400, bad[1]];
    if (count(userId) + checked.length > LIMIT) return [null, 409, "the portfolio is full"];
    return [checked.map(([record]) => record)];
  }

  // Answers /market/me/portfolio[s][/...] for a signed-in user, or returns false.
  async function handle({ method, path, user, request, response, json, body }) {
    const reply = (status, extra = {}) => (json(response, status, { ...state(user.id), ...extra }), true);
    const fail = (status, error) => (json(response, status, { error }), true);
    if (path === "/market/me/portfolio" && method === "GET") return reply(200);

    // Portfolios: create (optionally with records kept in the browser before signing in), rename, delete.
    if (path === "/market/me/portfolios" && method === "POST") {
      const input = await body(request);
      const title = name(input?.name);
      if (!title || [...title].length > 40) return fail(400, "name must be 1–40 characters");
      adoptLoose(user.id);
      if (sql("SELECT COUNT(*) AS n FROM portfolios WHERE user_id = ?").get(user.id).n >= PORTFOLIOS) return fail(409, "too many portfolios");
      const [records, status, error] = batch(user.id, Array.isArray(input?.transactions) ? input.transactions : []);
      if (!records) return fail(status, error);
      const id = Number(sql("INSERT INTO portfolios (user_id, name, created_at) VALUES (?, ?, ?)").run(user.id, title, now()).lastInsertRowid);
      for (const record of records) insert(user.id, id, record);
      return reply(201, { created: id });
    }
    const folder = /^\/market\/me\/portfolios\/(\d{1,15})(?:\/coins\/([^/]+))?$/.exec(path);
    if (folder) {
      const id = Number(folder[1]);
      if (!owns(user.id, id)) return fail(404, "no such portfolio");
      if (folder[2] !== undefined) {
        // Removing a coin from a portfolio deletes its records there.
        if (method !== "DELETE" || !COIN.test(folder[2])) return false;
        sql("DELETE FROM portfolio WHERE portfolio_id = ? AND user_id = ? AND coin_id = ?").run(id, user.id, folder[2]);
        return reply(200);
      }
      if (method === "PUT") {
        const title = name((await body(request))?.name);
        if (!title || [...title].length > 40) return fail(400, "name must be 1–40 characters");
        sql("UPDATE portfolios SET name = ? WHERE id = ?").run(title, id);
        return reply(200);
      }
      if (method === "DELETE") {
        sql("DELETE FROM portfolio WHERE portfolio_id = ? AND user_id = ?").run(id, user.id);
        sql("DELETE FROM portfolios WHERE id = ?").run(id);
        return reply(200);
      }
      return false;
    }

    // Records: one, or { transactions: [...] }, into a portfolio the visitor owns.
    if (path === "/market/me/portfolio" && method === "POST") {
      const input = await body(request);
      adoptLoose(user.id);
      const portfolioId = Number(input?.portfolioId);
      if (!owns(user.id, portfolioId)) return fail(404, "no such portfolio");
      const [records, status, error] = batch(user.id, Array.isArray(input?.transactions) ? input.transactions : [input]);
      if (!records) return fail(status, error);
      for (const record of records) insert(user.id, portfolioId, record);
      return reply(201);
    }
    const match = /^\/market\/me\/portfolio\/(\d{1,15})$/.exec(path);
    if (!match || (method !== "PUT" && method !== "DELETE")) return false;
    const id = Number(match[1]);
    if (!sql("SELECT 1 FROM portfolio WHERE id = ? AND user_id = ?").get(id, user.id)) return fail(404, "no such record");
    if (method === "DELETE") sql("DELETE FROM portfolio WHERE id = ?").run(id);
    else {
      const [record, error] = check(await body(request));
      if (!record) return fail(400, error);
      sql("UPDATE portfolio SET coin_id = ?, kind = ?, amount = ?, price = ?, fee = ?, at = ?, note = ? WHERE id = ?")
        .run(record.coinId, record.kind, record.amount, record.price, record.fee, record.at, record.note, id);
    }
    return reply(200);
  }

  const forget = (userId) => {
    sql("DELETE FROM portfolio WHERE user_id = ?").run(userId);
    sql("DELETE FROM portfolios WHERE user_id = ?").run(userId);
  };
  return { handle, forget };
}
