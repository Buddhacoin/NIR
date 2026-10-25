// NIR Markets wallet names: signed-in visitors suggest a name for an address
// ("Olympus exchange hot wallet") with a link to where it is published, and a
// moderator approves or rejects it. Approved names show on every transfer,
// wallet page and search result, ahead of the explorers' open labels. Part of
// the accounts service (market-accounts.mjs), sharing its database and checks.
//
// Limits: names of 2–40 characters, a https link of up to 300, ten
// suggestions per account a day. Only moderators (NIR_MARKET_ADMINS) see the
// queue and decide; a later approved name for the same address replaces it.
import { addressKind } from "./market-chain.mjs";

const DAY = 86_400_000;

export function createLabels({ db, now, isModerator }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS label_suggestions (id INTEGER PRIMARY KEY, address TEXT NOT NULL, name TEXT NOT NULL, link TEXT NOT NULL DEFAULT '',
      user_id INTEGER, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, decided_at INTEGER);
    CREATE INDEX IF NOT EXISTS label_suggestions_address ON label_suggestions (address, status, decided_at);
    CREATE INDEX IF NOT EXISTS label_suggestions_status ON label_suggestions (status, id);`);
  const sql = (text) => db.prepare(text);
  const canonical = (address) => (addressKind(address) === "evm" ? address.toLowerCase() : address);
  // address → approved name, kept in memory and refreshed on every decision.
  let approved = new Map();
  const reload = () => {
    approved = new Map(sql(`SELECT address, name FROM label_suggestions WHERE status = 'approved' ORDER BY decided_at, id`).all()
      .map((row) => [row.address, row.name]));
  };
  reload();
  const labelFor = (address) => (typeof address === "string" ? approved.get(canonical(address)) ?? null : null);
  const queue = () => sql(`SELECT s.id, s.address, s.name, s.link, s.created_at AS createdAt, users.username FROM label_suggestions AS s
    LEFT JOIN users ON users.id = s.user_id WHERE s.status = 'pending' ORDER BY s.id LIMIT 100`).all().map((row) => ({ ...row }));

  async function handle({ method, path, user, request, response, json, body }) {
    if (path === "/market/labels" && method === "POST") {
      const input = await body(request);
      const address = typeof input?.address === "string" ? input.address.trim() : "";
      const name = typeof input?.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
      const link = typeof input?.link === "string" ? input.link.trim() : "";
      if (!addressKind(address)) return json(response, 400, { error: "not an address" }), true;
      if ([...name].length < 2 || [...name].length > 40) return json(response, 400, { error: "name must be 2–40 characters" }), true;
      if (link && (!/^https:\/\/[^\s]+$/.test(link) || link.length > 300)) return json(response, 400, { error: "the link must start with https://" }), true;
      if (sql("SELECT COUNT(*) AS n FROM label_suggestions WHERE user_id = ? AND created_at > ?").get(user.id, now() - DAY).n >= 10) {
        return json(response, 429, { error: "ten suggestions a day" }), true;
      }
      sql("INSERT INTO label_suggestions (address, name, link, user_id, created_at) VALUES (?, ?, ?, ?, ?)").run(canonical(address), name, link, user.id, now());
      return json(response, 201, { ok: true }), true;
    }
    if (path === "/market/labels/pending" && method === "GET") {
      if (!isModerator(user)) return json(response, 403, { error: "moderators only" }), true;
      return json(response, 200, { suggestions: queue() }), true;
    }
    const decision = /^\/market\/labels\/(\d{1,12})\/(approve|reject)$/.exec(path);
    if (decision && method === "POST") {
      if (!isModerator(user)) return json(response, 403, { error: "moderators only" }), true;
      if (!sql("SELECT 1 FROM label_suggestions WHERE id = ?").get(Number(decision[1]))) return json(response, 404, { error: "no such suggestion" }), true;
      sql("UPDATE label_suggestions SET status = ?, decided_at = ? WHERE id = ?").run(decision[2] === "approve" ? "approved" : "rejected", now(), Number(decision[1]));
      reload();
      return json(response, 200, { suggestions: queue() }), true;
    }
    return false;
  }
  // A deleted account's suggestions stay (approved names belong to the site) but lose their author.
  const forget = (userId) => sql("UPDATE label_suggestions SET user_id = NULL WHERE user_id = ?").run(userId);
  return { handle, labelFor, forget };
}
