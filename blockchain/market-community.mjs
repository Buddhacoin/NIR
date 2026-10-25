// NIR Markets community: comments on a coin's page and the daily
// "rise or fall" vote. Part of the accounts service (market-accounts.mjs),
// sharing its database, sessions and checks.
//
// Comments: up to 1,000 characters, an optional rise/fall tag, one level of
// replies, likes, reports (three reports hide a comment until a moderator
// looks), deletion by the author or a moderator. Posting is limited to one
// comment every 20 seconds and 50 a day per account. The vote: one per
// account per coin per UTC day; the split is shown after voting.

const COIN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SIDES = new Set(["rise", "fall"]);
const PAGE = 30;
const HIDE_AFTER_REPORTS = 3;

export function createCommunity({ db, now, userFor, json, body, origin, log, limited, admins = [] }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY, coin_id TEXT NOT NULL, user_id INTEGER NOT NULL,
      parent_id INTEGER, body TEXT NOT NULL, side TEXT, created_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS comments_coin ON comments (coin_id, parent_id, id);
    CREATE INDEX IF NOT EXISTS comments_user ON comments (user_id, id);
    CREATE TABLE IF NOT EXISTS likes (comment_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (comment_id, user_id));
    CREATE TABLE IF NOT EXISTS reports (comment_id INTEGER NOT NULL, user_id INTEGER NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (comment_id, user_id));
    CREATE TABLE IF NOT EXISTS votes (coin_id TEXT NOT NULL, user_id INTEGER NOT NULL, day TEXT NOT NULL, side TEXT NOT NULL,
      PRIMARY KEY (coin_id, user_id, day));`);
  const sql = (text) => db.prepare(text);
  const moderators = new Set(admins.map((email) => email.trim().toLowerCase()).filter(Boolean));
  const isModerator = (user) => Boolean(user && moderators.has(user.email.toLowerCase()));
  const today = () => new Date(now()).toISOString().slice(0, 10);

  const SELECT = `SELECT comments.id, comments.coin_id AS coinId, comments.parent_id AS parentId, comments.body, comments.side,
    comments.created_at AS createdAt, comments.user_id AS userId, users.username, users.display_name AS displayName,
    (SELECT COUNT(*) FROM likes WHERE likes.comment_id = comments.id) AS likes
    FROM comments JOIN users ON users.id = comments.user_id`;
  function shape(row, viewer) {
    return { id: row.id, coinId: row.coinId, parentId: row.parentId, body: row.body, side: row.side, createdAt: row.createdAt,
      author: { username: row.username, displayName: row.displayName }, likes: row.likes,
      liked: Boolean(viewer && sql("SELECT 1 FROM likes WHERE comment_id = ? AND user_id = ?").get(row.id, viewer.id)),
      mine: viewer?.id === row.userId, canDelete: viewer?.id === row.userId || isModerator(viewer) };
  }

  function list(coinId, viewer, sort, before) {
    const order = sort === "top" ? "likes DESC, comments.id DESC" : "comments.id DESC";
    const rows = sql(`${SELECT} WHERE comments.coin_id = ? AND comments.parent_id IS NULL AND comments.hidden = 0
      ${sort === "top" ? "" : "AND comments.id < ?"} ORDER BY ${order} LIMIT ${PAGE}`)
      .all(...(sort === "top" ? [coinId] : [coinId, before]));
    return rows.map((row) => ({ ...shape(row, viewer),
      replies: sql(`${SELECT} WHERE comments.parent_id = ? AND comments.hidden = 0 ORDER BY comments.id LIMIT 50`)
        .all(row.id).map((reply) => shape(reply, viewer)) }));
  }

  function sentiment(coinId, viewer) {
    const day = today();
    const counts = Object.fromEntries(sql("SELECT side, COUNT(*) AS n FROM votes WHERE coin_id = ? AND day = ? GROUP BY side")
      .all(coinId, day).map((row) => [row.side, row.n]));
    const mine = viewer ? sql("SELECT side FROM votes WHERE coin_id = ? AND user_id = ? AND day = ?").get(coinId, viewer.id, day)?.side ?? null : null;
    return { rise: counts.rise ?? 0, fall: counts.fall ?? 0, mine, day };
  }

  // A user's latest visible comments, for their profile.
  const byUser = (userId, viewer) => sql(`${SELECT} WHERE comments.user_id = ? AND comments.hidden = 0
    ORDER BY comments.id DESC LIMIT 20`).all(userId).map((row) => shape(row, viewer));

  function post(user, coinId, input) {
    const text = String(input?.body ?? "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text || [...text].length > 1000) return [400, { error: "a comment is 1–1000 characters" }];
    const side = input?.side === undefined || input?.side === null ? null : String(input.side);
    if (side !== null && !SIDES.has(side)) return [400, { error: "the tag is rise or fall" }];
    let parentId = null;
    if (input?.parentId !== undefined && input?.parentId !== null) {
      const parent = sql("SELECT id, parent_id, coin_id, hidden FROM comments WHERE id = ?").get(Number(input.parentId));
      if (!parent || parent.hidden || parent.coin_id !== coinId) return [404, { error: "no such comment" }];
      parentId = parent.parent_id ?? parent.id; // replies stay one level deep
    }
    const last = sql("SELECT MAX(created_at) AS at, COUNT(*) AS n FROM comments WHERE user_id = ? AND created_at > ?")
      .get(user.id, now() - 86_400_000);
    if (last.at && now() - last.at < 20_000) return [429, { error: "wait 20 seconds between comments" }];
    if (last.n >= 50) return [429, { error: "50 comments a day is the limit" }];
    const { lastInsertRowid } = sql("INSERT INTO comments (coin_id, user_id, parent_id, body, side, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(coinId, user.id, parentId, text, side, now());
    log(user.id, "comment", coinId, true);
    return [201, { comment: shape(sql(`${SELECT} WHERE comments.id = ?`).get(lastInsertRowid), user) }];
  }

  // Answers /market/coin/<id>/comments|sentiment and /market/comments/<n>[/like|/report], or returns false.
  async function handle(request, response, url) {
    const path = url.pathname;
    const coin = /^\/market\/coin\/([^/]+)\/(comments|sentiment)$/.exec(path);
    const one = /^\/market\/comments\/(\d{1,12})(?:\/(like|report))?$/.exec(path);
    if (!coin && !one) return false;
    if (coin && !COIN.test(coin[1])) return json(response, 404, { error: "unknown coin" }), true;
    const method = request.method;
    const viewer = userFor(request);
    if (method === "GET" && coin) {
      if (coin[2] === "sentiment") json(response, 200, sentiment(coin[1], viewer));
      else json(response, 200, { comments: list(coin[1], viewer, url.searchParams.get("sort") === "top" ? "top" : "latest",
        Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER) });
      return true;
    }
    if (request.headers.origin !== origin) return json(response, 403, { error: "cross-site request" }), true;
    if (!viewer) return json(response, 401, { error: "sign in first" }), true;
    if (limited(viewer.id)) return json(response, 429, { error: "too many changes, wait a minute" }), true;
    try {
      if (method === "POST" && coin?.[2] === "comments") {
        const [status, result] = post(viewer, coin[1], await body(request));
        json(response, status, result);
      } else if (method === "POST" && coin?.[2] === "sentiment") {
        const { side } = await body(request);
        if (!SIDES.has(side)) return json(response, 400, { error: "vote rise or fall" }), true;
        sql("INSERT OR IGNORE INTO votes (coin_id, user_id, day, side) VALUES (?, ?, ?, ?)").run(coin[1], viewer.id, today(), side);
        json(response, 200, sentiment(coin[1], viewer));
      } else if (one) {
        const comment = sql("SELECT * FROM comments WHERE id = ?").get(Number(one[1]));
        if (!comment || (comment.hidden && !isModerator(viewer))) return json(response, 404, { error: "no such comment" }), true;
        if (one[2] === "like" && (method === "PUT" || method === "DELETE")) {
          if (method === "PUT") sql("INSERT OR IGNORE INTO likes (comment_id, user_id) VALUES (?, ?)").run(comment.id, viewer.id);
          else sql("DELETE FROM likes WHERE comment_id = ? AND user_id = ?").run(comment.id, viewer.id);
          json(response, 200, { likes: sql("SELECT COUNT(*) AS n FROM likes WHERE comment_id = ?").get(comment.id).n,
            liked: method === "PUT" });
        } else if (one[2] === "report" && method === "POST") {
          if (comment.user_id === viewer.id) return json(response, 400, { error: "that is your own comment" }), true;
          sql("INSERT OR IGNORE INTO reports (comment_id, user_id, at) VALUES (?, ?, ?)").run(comment.id, viewer.id, now());
          const reports = sql("SELECT COUNT(*) AS n FROM reports WHERE comment_id = ?").get(comment.id).n;
          if (reports >= HIDE_AFTER_REPORTS) sql("UPDATE comments SET hidden = 1 WHERE id = ?").run(comment.id);
          json(response, 200, { reported: true });
        } else if (!one[2] && method === "DELETE") {
          if (comment.user_id !== viewer.id && !isModerator(viewer)) return json(response, 403, { error: "not yours" }), true;
          sql("DELETE FROM likes WHERE comment_id IN (SELECT id FROM comments WHERE id = ? OR parent_id = ?)").run(comment.id, comment.id);
          sql("DELETE FROM reports WHERE comment_id IN (SELECT id FROM comments WHERE id = ? OR parent_id = ?)").run(comment.id, comment.id);
          sql("DELETE FROM comments WHERE id = ? OR parent_id = ?").run(comment.id, comment.id);
          json(response, 200, { deleted: true });
        } else {
          json(response, 404, { error: "not found" });
        }
      } else {
        json(response, 404, { error: "not found" });
      }
    } catch (error) {
      json(response, error?.status ?? 500, { error: error?.status ? error.message : "server error" });
    }
    return true;
  }

  // Removes everything a deleted account wrote: comments (with their replies), likes, reports, votes.
  function forget(userId) {
    const own = "SELECT id FROM comments WHERE user_id = ? OR parent_id IN (SELECT id FROM comments WHERE user_id = ?)";
    sql(`DELETE FROM likes WHERE user_id = ? OR comment_id IN (${own})`).run(userId, userId, userId);
    sql(`DELETE FROM reports WHERE user_id = ? OR comment_id IN (${own})`).run(userId, userId, userId);
    sql("DELETE FROM comments WHERE user_id = ? OR parent_id IN (SELECT id FROM comments WHERE user_id = ?)").run(userId, userId);
    sql("DELETE FROM votes WHERE user_id = ?").run(userId);
  }

  return { handle, byUser, sentiment, forget };
}
