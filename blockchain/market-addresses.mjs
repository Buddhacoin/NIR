// NIR Markets saved addresses: the wallets a signed-in visitor follows
// ("tracked", like bookmarks on the analytics sites) and the ones they mark
// as their own, whose holdings the profile adds up. Part of the accounts
// service (market-accounts.mjs), sharing its database and checks.
//
// The list is private: no profile, feed or other visitor sees it. Up to 100
// addresses per account, each with an optional label of up to 40 characters.
// Own wallets sit in named portfolios ("Main", "Trading"…, up to 20), as on the
// analytics sites: the profile's dashboard shows one portfolio at a time.
//
// GET /market/me/addresses → { addresses: [{ address, label, mine, portfolioId, addedAt }], portfolios: [{ id, name }] }
// (an address may be an organisation followed as one wallet: "entity:<name>")
// PUT/DELETE /market/me/addresses/<address> { label?, mine?, portfolioId? }
// POST /market/me/wallet-portfolios { name } · PATCH …/wallet-portfolios/<id> { name } · DELETE …/wallet-portfolios/<id>
import { addressKind } from "./market-chain.mjs";

const LIMIT = 100;
const PORTFOLIOS = 20;
const cleanName = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

export function createAddresses({ db, now }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_addresses (user_id INTEGER NOT NULL, address TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
      mine INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL, PRIMARY KEY (user_id, address));
    CREATE TABLE IF NOT EXISTS wallet_portfolios (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  try { db.exec("ALTER TABLE saved_addresses ADD COLUMN portfolio_id INTEGER"); } catch {} // added later; present on new databases too
  const sql = (text) => db.prepare(text);
  const portfolios = (userId) => sql("SELECT id, name FROM wallet_portfolios WHERE user_id = ? ORDER BY id").all(userId).map((row) => ({ id: Number(row.id), name: row.name }));
  // Own wallets saved before portfolios existed go into a first one, so nothing is lost.
  function settle(userId) {
    const loose = sql("SELECT COUNT(*) AS n FROM saved_addresses WHERE user_id = ? AND mine = 1 AND portfolio_id IS NULL").get(userId).n;
    if (!loose) return;
    const first = portfolios(userId)[0]?.id ?? Number(sql("INSERT INTO wallet_portfolios (user_id, name, created_at) VALUES (?, ?, ?)").run(userId, "Основной", now()).lastInsertRowid);
    sql("UPDATE saved_addresses SET portfolio_id = ? WHERE user_id = ? AND mine = 1 AND portfolio_id IS NULL").run(first, userId);
  }
  const list = (userId) => sql("SELECT address, label, mine, portfolio_id AS portfolioId, added_at AS addedAt FROM saved_addresses WHERE user_id = ? ORDER BY added_at DESC")
    .all(userId).map((row) => ({ ...row, mine: Boolean(row.mine), portfolioId: row.portfolioId === null ? null : Number(row.portfolioId) }));
  const answer = (userId) => { settle(userId); return { addresses: list(userId), portfolios: portfolios(userId) }; };
  // Account-based addresses are kept in one spelling, so the same wallet is never saved twice.
  const canonical = (address) => (addressKind(address) === "evm" ? address.toLowerCase() : address);

  async function handle({ method, path, user, request, response, json, body }) {
    if (path === "/market/me/addresses" && method === "GET") return json(response, 200, answer(user.id)), true;
    // Named portfolios of own wallets.
    if (path === "/market/me/wallet-portfolios" && method === "POST") {
      const name = cleanName((await body(request))?.name);
      if (!name || [...name].length > 40) return json(response, 400, { error: "a name of 1 to 40 characters" }), true;
      // A second portfolio of the same name (a double tap) is the first one.
      const same = portfolios(user.id).find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (same) return json(response, 200, { ...answer(user.id), id: same.id }), true;
      if (portfolios(user.id).length >= PORTFOLIOS) return json(response, 409, { error: "too many portfolios" }), true;
      const id = Number(sql("INSERT INTO wallet_portfolios (user_id, name, created_at) VALUES (?, ?, ?)").run(user.id, name, now()).lastInsertRowid);
      return json(response, 200, { ...answer(user.id), id }), true;
    }
    const folder = /^\/market\/me\/wallet-portfolios\/(\d{1,12})$/.exec(path);
    if (folder && (method === "PATCH" || method === "DELETE")) {
      const id = Number(folder[1]);
      if (!portfolios(user.id).some((item) => item.id === id)) return json(response, 404, { error: "no such portfolio" }), true;
      if (method === "DELETE") {
        // Its wallets stay saved, as tracked ones.
        sql("UPDATE saved_addresses SET mine = 0, portfolio_id = NULL WHERE user_id = ? AND portfolio_id = ?").run(user.id, id);
        sql("DELETE FROM wallet_portfolios WHERE user_id = ? AND id = ?").run(user.id, id);
        return json(response, 200, answer(user.id)), true;
      }
      const name = cleanName((await body(request))?.name);
      if (!name || [...name].length > 40) return json(response, 400, { error: "a name of 1 to 40 characters" }), true;
      sql("UPDATE wallet_portfolios SET name = ? WHERE user_id = ? AND id = ?").run(name, user.id, id);
      return json(response, 200, answer(user.id)), true;
    }
    const match = /^\/market\/me\/addresses\/([^/]+)$/.exec(path);
    if (!match || (method !== "PUT" && method !== "DELETE")) return false;
    // An organisation followed as one wallet ("entity:Binance") or a known wallet under its id ("w:binance"):
    // their addresses stay on the server.
    let raw = match[1];
    try { raw = decodeURIComponent(match[1]); } catch {}
    const entity = /^entity:[^\u0000-\u001f]{2,60}$/.test(raw) || /^w:[a-z0-9-]{2,40}$/.test(raw);
    if (!entity && !addressKind(match[1])) return json(response, 400, { error: "not an address" }), true;
    const address = entity ? raw.replace(/\s+/g, " ").trim() : canonical(match[1]);
    if (method === "DELETE") {
      sql("DELETE FROM saved_addresses WHERE user_id = ? AND address = ?").run(user.id, address);
      return json(response, 200, answer(user.id)), true;
    }
    const input = await body(request);
    const label = typeof input?.label === "string" ? input.label.replace(/\s+/g, " ").trim() : undefined;
    if (label !== undefined && [...label].length > 40) return json(response, 400, { error: "label must be at most 40 characters" }), true;
    const existing = sql("SELECT * FROM saved_addresses WHERE user_id = ? AND address = ?").get(user.id, address);
    if (!existing && sql("SELECT COUNT(*) AS n FROM saved_addresses WHERE user_id = ?").get(user.id).n >= LIMIT) {
      return json(response, 409, { error: "too many addresses" }), true;
    }
    // A wallet put in a portfolio is an own one; one made not own leaves its portfolio.
    let portfolioId = existing?.portfolio_id ?? null;
    if (input?.portfolioId !== undefined) {
      if (input.portfolioId !== null && !portfolios(user.id).some((item) => item.id === Number(input.portfolioId))) return json(response, 404, { error: "no such portfolio" }), true;
      portfolioId = input.portfolioId === null ? null : Number(input.portfolioId);
    }
    const mine = portfolioId !== null && input?.mine !== false ? 1 : typeof input?.mine === "boolean" ? (input.mine ? 1 : 0) : existing?.mine ?? 0;
    if (!mine) portfolioId = null;
    sql(`INSERT INTO saved_addresses (user_id, address, label, mine, portfolio_id, added_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, address) DO UPDATE SET label = excluded.label, mine = excluded.mine, portfolio_id = excluded.portfolio_id`)
      .run(user.id, address, label ?? existing?.label ?? "", mine, portfolioId, now());
    return json(response, 200, answer(user.id)), true;
  }

  const forget = (userId) => { sql("DELETE FROM saved_addresses WHERE user_id = ?").run(userId); sql("DELETE FROM wallet_portfolios WHERE user_id = ?").run(userId); };
  return { handle, forget };
}
