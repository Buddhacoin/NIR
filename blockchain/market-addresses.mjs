// NIR Markets saved addresses: the wallets a signed-in visitor follows
// ("tracked", like bookmarks on the analytics sites) and the ones they mark
// as their own, whose holdings the profile adds up. Part of the accounts
// service (market-accounts.mjs), sharing its database and checks.
//
// The list is private: no profile, feed or other visitor sees it. Up to 100
// addresses per account, each with an optional label of up to 40 characters.
import { addressKind } from "./market-chain.mjs";

const LIMIT = 100;

export function createAddresses({ db, now }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_addresses (user_id INTEGER NOT NULL, address TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
      mine INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL, PRIMARY KEY (user_id, address));`);
  const sql = (text) => db.prepare(text);
  const list = (userId) => sql("SELECT address, label, mine, added_at AS addedAt FROM saved_addresses WHERE user_id = ? ORDER BY added_at DESC")
    .all(userId).map((row) => ({ ...row, mine: Boolean(row.mine) }));
  // Account-based addresses are kept in one spelling, so the same wallet is never saved twice.
  const canonical = (address) => (addressKind(address) === "evm" ? address.toLowerCase() : address);

  async function handle({ method, path, user, request, response, json, body }) {
    if (path === "/market/me/addresses" && method === "GET") return json(response, 200, { addresses: list(user.id) }), true;
    const match = /^\/market\/me\/addresses\/([^/]+)$/.exec(path);
    if (!match || (method !== "PUT" && method !== "DELETE")) return false;
    if (!addressKind(match[1])) return json(response, 400, { error: "not an address" }), true;
    const address = canonical(match[1]);
    if (method === "DELETE") {
      sql("DELETE FROM saved_addresses WHERE user_id = ? AND address = ?").run(user.id, address);
      return json(response, 200, { addresses: list(user.id) }), true;
    }
    const input = await body(request);
    const label = typeof input?.label === "string" ? input.label.replace(/\s+/g, " ").trim() : undefined;
    if (label !== undefined && [...label].length > 40) return json(response, 400, { error: "label must be at most 40 characters" }), true;
    const existing = sql("SELECT * FROM saved_addresses WHERE user_id = ? AND address = ?").get(user.id, address);
    if (!existing && sql("SELECT COUNT(*) AS n FROM saved_addresses WHERE user_id = ?").get(user.id).n >= LIMIT) {
      return json(response, 409, { error: "too many addresses" }), true;
    }
    sql(`INSERT INTO saved_addresses (user_id, address, label, mine, added_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, address) DO UPDATE SET label = excluded.label, mine = excluded.mine`)
      .run(user.id, address, label ?? existing?.label ?? "", typeof input?.mine === "boolean" ? (input.mine ? 1 : 0) : existing?.mine ?? 0, now());
    return json(response, 200, { addresses: list(user.id) }), true;
  }

  const forget = (userId) => sql("DELETE FROM saved_addresses WHERE user_id = ?").run(userId);
  return { handle, forget };
}
