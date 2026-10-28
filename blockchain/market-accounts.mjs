// NIR Markets accounts: Google sign-in, a profile with recent activity and a
// watchlist kept on the server. Part of the market service (Caddy passes
// /market/* to it); the data lives in one SQLite file.
//
// Sign-in is OpenID Connect's authorization-code flow with PKCE, a state and
// a nonce. The ID token comes straight from Google's token endpoint over TLS,
// so its claims are checked (issuer, audience, expiry, nonce, verified email)
// rather than its signature. The session is a random token in an HttpOnly,
// Secure, SameSite=Lax cookie; the database keeps only its SHA-256.
// Changes need a same-origin request (Origin header) and are rate limited.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createCommunity } from "./market-community.mjs";
import { createAddresses } from "./market-addresses.mjs";
import { createAlerts } from "./market-alerts.mjs";
import { createLabels } from "./market-labels.mjs";
import { createPortfolio } from "./market-portfolio.mjs";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const SESSION_DAYS = 30;
const WATCH_LIMIT = 500;
const USERNAME = /^[a-z0-9_]{3,20}$/;
const COIN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const DAY = 86_400_000;

const base64url = (bytes) => Buffer.from(bytes).toString("base64url");
const sha256 = (value) => createHash("sha256").update(value).digest("base64url");

export function readCookie(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

// The ID token's middle part, decoded; Google's token endpoint is the only source.
export function idTokenClaims(token) {
  const part = String(token ?? "").split(".")[1];
  if (!part) throw new Error("id token is missing");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export function checkClaims(claims, { clientId, nonce, now }) {
  if (!GOOGLE_ISSUERS.has(claims?.iss)) throw new Error("id token issuer is wrong");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId)) throw new Error("id token audience is wrong");
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 < now) throw new Error("id token has expired");
  if (claims.nonce !== nonce) throw new Error("id token nonce is wrong");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw new Error("id token subject is wrong");
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new Error("email is not verified");
  return { sub: claims.sub, email: String(claims.email ?? "").slice(0, 320) };
}

export function createAccounts({
  file, clientId = "", clientSecret = "", publicUrl = "http://localhost:8790", now = Date.now, admins = [], pushFetch = fetch,
  post = async (url, form) => {
    const response = await fetch(url, { method: "POST", body: new URLSearchParams(form),
      headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`token endpoint answered ${response.status}`);
    return response.json();
  },
} = {}) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, google_sub TEXT UNIQUE NOT NULL, email TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, username_changed_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS watchlist (user_id INTEGER NOT NULL, coin_id TEXT NOT NULL, added_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, coin_id));
    CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL,
      coin_id TEXT, public INTEGER NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS activity_user ON activity (user_id, at);
    CREATE TABLE IF NOT EXISTS avatars (user_id INTEGER PRIMARY KEY, type TEXT NOT NULL, image BLOB NOT NULL, updated_at INTEGER NOT NULL);`);
  const sql = (text) => db.prepare(text);
  const origin = new URL(publicUrl).origin;
  const secure = origin.startsWith("https:");
  // Browsers take a __Host- cookie only over HTTPS; plain local runs use a plain name.
  const COOKIE = secure ? "__Host-nir_session" : "nir_session";
  const pending = new Map(); // sign-in state → PKCE verifier, nonce, where to return; ten minutes
  const writes = new Map(); // user → recent change times, for the rate limit

  const enabled = Boolean(clientId && clientSecret);
  const log = (userId, kind, coinId = null, visible = false) =>
    sql("INSERT INTO activity (user_id, kind, coin_id, public, at) VALUES (?, ?, ?, ?, ?)").run(userId, kind, coinId, visible ? 1 : 0, now());

  function newUsername() {
    for (;;) {
      const name = `user${randomBytes(4).readUInt32BE() % 900_000 + 100_000}`;
      if (!sql("SELECT 1 FROM users WHERE username = ?").get(name)) return name;
    }
  }

  function userFor(request) {
    const token = readCookie(request.headers.cookie, COOKIE);
    if (!token || token.length > 100) return null;
    const row = sql(`SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).get(sha256(token), now());
    return row ?? null;
  }

  // A picture the user chose, served from /market/avatar/<username>; the version in the address changes with it.
  const avatarUrl = (userId, username) => {
    const row = sql("SELECT updated_at FROM avatars WHERE user_id = ?").get(userId);
    return row ? `/market/avatar/${username}?v=${row.updated_at}` : null;
  };
  const profile = (user) => ({ username: user.username, displayName: user.display_name, bio: user.bio, joinedAt: user.created_at,
    avatar: avatarUrl(user.id, user.username) });
  // A small square picture, made by the page (128 px), as a data address: JPEG, PNG or WebP, 12 KB at most.
  function setAvatar(user, changes) {
    const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(changes?.image ?? ""));
    if (!match) return [400, { error: "a JPEG, PNG or WebP picture, please" }];
    const image = Buffer.from(match[2], "base64");
    const kinds = { jpeg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47] };
    const looks = match[1] === "webp" ? image.subarray(0, 4).toString("latin1") === "RIFF" && image.subarray(8, 12).toString("latin1") === "WEBP"
      : kinds[match[1]].every((byte, index) => image[index] === byte);
    if (!looks || image.length > 12_000) return [400, { error: "the picture is not valid or is too large" }];
    sql("INSERT INTO avatars (user_id, type, image, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET type = excluded.type, image = excluded.image, updated_at = excluded.updated_at")
      .run(user.id, `image/${match[1]}`, image, now());
    return [200, { user: profile(user) }];
  }
  const activity = (userId, publicOnly) => sql(`SELECT kind, coin_id AS coinId, at FROM activity
    WHERE user_id = ? ${publicOnly ? "AND public = 1" : ""} ORDER BY at DESC, id DESC LIMIT 50`).all(userId)
    .map((row) => ({ ...row }));
  const watchlist = (userId) => sql("SELECT coin_id FROM watchlist WHERE user_id = ? ORDER BY added_at, rowid")
    .all(userId).map((row) => row.coin_id);

  function json(response, status, body, headers = {}) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
    response.end(JSON.stringify(body));
  }
  const redirect = (response, location, headers = {}) => {
    response.writeHead(302, { location, "cache-control": "no-store", ...headers });
    response.end();
  };
  const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

  async function body(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 16_384) throw Object.assign(new Error("body is too large"), { status: 413 });
      chunks.push(chunk);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
      throw Object.assign(new Error("body is not JSON"), { status: 400 });
    }
  }

  function startSignIn(url, response) {
    if (!enabled) return json(response, 503, { error: "sign-in is not configured" });
    for (const [key, value] of pending) if (now() - value.at > 600_000) pending.delete(key);
    if (pending.size > 10_000) return json(response, 503, { error: "too many sign-ins, try again in a minute" });
    const state = base64url(randomBytes(24));
    const verifier = base64url(randomBytes(32));
    const nonce = base64url(randomBytes(24));
    const back = url.searchParams.get("return") ?? "/";
    const returnTo = /^\/(?![/\\])[^\s]{0,300}$/.test(back) ? back : "/";
    pending.set(state, { verifier, nonce, returnTo, at: now() });
    const target = new URL(GOOGLE_AUTH);
    target.search = new URLSearchParams({ client_id: clientId, redirect_uri: `${origin}/market/auth/google/callback`,
      response_type: "code", scope: "openid email profile", state, nonce, code_challenge: sha256(verifier),
      code_challenge_method: "S256", prompt: "select_account" }).toString();
    return redirect(response, target.href);
  }

  async function finishSignIn(url, response) {
    const flow = pending.get(url.searchParams.get("state") ?? "");
    pending.delete(url.searchParams.get("state") ?? "");
    const code = url.searchParams.get("code");
    if (!enabled || !flow || now() - flow.at > 600_000 || !code) return redirect(response, "/?signin=failed");
    let identity;
    try {
      const tokens = await post(GOOGLE_TOKEN, { client_id: clientId, client_secret: clientSecret, code,
        code_verifier: flow.verifier, grant_type: "authorization_code", redirect_uri: `${origin}/market/auth/google/callback` });
      identity = checkClaims(idTokenClaims(tokens?.id_token), { clientId, nonce: flow.nonce, now: now() });
    } catch {
      return redirect(response, "/?signin=failed");
    }
    let user = sql("SELECT * FROM users WHERE google_sub = ?").get(identity.sub);
    if (!user) {
      const username = newUsername();
      const { lastInsertRowid } = sql(`INSERT INTO users (google_sub, email, username, display_name, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(identity.sub, identity.email, username, username, now());
      user = sql("SELECT * FROM users WHERE id = ?").get(lastInsertRowid);
      log(user.id, "joined", null, true);
    } else if (identity.email && identity.email !== user.email) {
      sql("UPDATE users SET email = ? WHERE id = ?").run(identity.email, user.id);
    }
    const token = base64url(randomBytes(32));
    sql("DELETE FROM sessions WHERE expires_at <= ?").run(now());
    sql("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), user.id, now() + SESSION_DAYS * DAY);
    return redirect(response, flow.returnTo, { "set-cookie": cookie(token, SESSION_DAYS * 86_400) });
  }

  function limited(userId) {
    const recent = (writes.get(userId) ?? []).filter((at) => now() - at < 60_000);
    recent.push(now());
    writes.set(userId, recent);
    return recent.length > 60;
  }

  function updateProfile(user, changes) {
    const fields = {};
    if (changes.username !== undefined && changes.username !== user.username) {
      const name = String(changes.username).toLowerCase();
      if (!USERNAME.test(name)) return [400, { error: "username must be 3–20 letters, digits or _" }];
      if (now() - user.username_changed_at < 7 * DAY) return [429, { error: "username can change once a week" }];
      if (sql("SELECT 1 FROM users WHERE username = ?").get(name)) return [409, { error: "username is taken" }];
      fields.username = name;
      fields.username_changed_at = now();
    }
    if (changes.displayName !== undefined) {
      const name = String(changes.displayName).replace(/\s+/g, " ").trim();
      if (!name || [...name].length > 20) return [400, { error: "display name must be 1–20 characters" }];
      fields.display_name = name;
    }
    if (changes.bio !== undefined) {
      const bio = String(changes.bio).trim();
      if ([...bio].length > 250) return [400, { error: "bio must be at most 250 characters" }];
      fields.bio = bio;
    }
    const keys = Object.keys(fields);
    if (keys.length) {
      sql(`UPDATE users SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((key) => fields[key]), user.id);
      log(user.id, "profile");
    }
    return [200, { user: profile(sql("SELECT * FROM users WHERE id = ?").get(user.id)) }];
  }

  function addWatch(userId, coinId) {
    const count = sql("SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?").get(userId).n;
    if (count >= WATCH_LIMIT) return false;
    const { changes } = sql("INSERT OR IGNORE INTO watchlist (user_id, coin_id, added_at) VALUES (?, ?, ?)").run(userId, coinId, now());
    if (changes) log(userId, "watch", coinId);
    return true;
  }

  // Comments and the daily vote (market-community.mjs) share the database and sessions.
  const community = createCommunity({ db, now, userFor, json, body, origin, log, limited, admins });
  // The private portfolio (market-portfolio.mjs) lives under /market/me/portfolio.
  const portfolio = createPortfolio({ db, now });
  // Price alerts and browser notifications (market-alerts.mjs) under /market/me/alerts and /market/me/push.
  const alerts = createAlerts({ db, now, publicUrl, fetch: pushFetch });
  // Tracked and own wallet addresses (market-addresses.mjs) under /market/me/addresses.
  const addresses = createAddresses({ db, now });
  // Wallet names suggested by visitors and approved by moderators (market-labels.mjs) under /market/labels.
  const moderators = new Set(admins.map((email) => email.trim().toLowerCase()).filter(Boolean));
  const isModerator = (user) => Boolean(user && moderators.has(user.email.toLowerCase()));
  const labels = createLabels({ db, now, isModerator });

  // Answers a request under /market/auth, /market/me, /market/u or the community's paths, or returns false.
  async function handle(request, response, url) {
    if (await community.handle(request, response, url)) return true;
    const path = url.pathname;
    if (!/^\/market\/(auth|me|u|labels|stats|avatar)(\/|$)/.test(path)) return false;
    // GET /market/avatar/<username>: the picture a user chose.
    const avatarMatch = /^\/market\/avatar\/([a-z0-9_]{3,20})$/.exec(path);
    if (avatarMatch && request.method === "GET") {
      const row = sql("SELECT avatars.type, avatars.image FROM avatars JOIN users ON users.id = avatars.user_id WHERE users.username = ?").get(avatarMatch[1]);
      if (!row) { json(response, 404, { error: "no picture" }); return true; }
      response.writeHead(200, { "content-type": row.type, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'" });
      response.end(Buffer.from(row.image));
      return true;
    }
    // GET /market/stats: how many accounts the site has, for the strip at the top.
    if (request.method === "GET" && path === "/market/stats") {
      json(response, 200, { users: sql("SELECT COUNT(*) AS n FROM users").get().n }, { "cache-control": "public, max-age=60" });
      return true;
    }
    const method = request.method;
    if (method === "GET" && path === "/market/auth/google") return startSignIn(url, response), true;
    if (method === "GET" && path === "/market/auth/google/callback") return await finishSignIn(url, response), true;
    const profileMatch = /^\/market\/u\/([a-z0-9_]{3,20})$/.exec(path);
    if (method === "GET" && profileMatch) {
      const user = sql("SELECT * FROM users WHERE username = ?").get(profileMatch[1]);
      const viewer = userFor(request);
      if (!user) json(response, 404, { error: "no such user" });
      else json(response, 200, { user: profile(user), own: viewer?.id === user.id,
        activity: activity(user.id, viewer?.id !== user.id), comments: community.byUser(user.id, viewer) });
      return true;
    }
    const user = userFor(request);
    if (method === "GET" && path === "/market/me") {
      json(response, 200, user ? { signIn: enabled, user: profile(user), email: user.email, watchlist: watchlist(user.id), alertsUnseen: alerts.unseen(user.id), moderator: isModerator(user) } : { signIn: enabled, user: null });
      return true;
    }
    // Every change below comes from a page on this site, from a signed-in visitor.
    if (method !== "GET" && request.headers.origin !== origin) return json(response, 403, { error: "cross-site request" }), true;
    if (method === "POST" && path === "/market/auth/logout") {
      const token = readCookie(request.headers.cookie, COOKIE);
      if (token) sql("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
      json(response, 200, { ok: true }, { "set-cookie": cookie("", 0) });
      return true;
    }
    if (!user) return json(response, 401, { error: "sign in first" }), true;
    if (limited(user.id)) return json(response, 429, { error: "too many changes, wait a minute" }), true;
    try {
      if (await portfolio.handle({ method, path, user, request, response, json, body })) return true;
      if (await alerts.handle({ method, path, user, request, response, json, body })) return true;
      if (await addresses.handle({ method, path, user, request, response, json, body })) return true;
      if (await labels.handle({ method, path, user, request, response, json, body })) return true;
      const watchMatch = /^\/market\/me\/watchlist\/([^/]+)$/.exec(path);
      if (method === "DELETE" && path === "/market/me") {
        // Deleting the account removes all of its data at once, and signs it out everywhere.
        community.forget(user.id);
        portfolio.forget(user.id);
        alerts.forget(user.id);
        addresses.forget(user.id);
        labels.forget(user.id);
        for (const table of ["sessions", "watchlist", "activity", "avatars"]) sql(`DELETE FROM ${table} WHERE user_id = ?`).run(user.id);
        sql("DELETE FROM users WHERE id = ?").run(user.id);
        json(response, 200, { deleted: true }, { "set-cookie": cookie("", 0) });
      } else if (method === "PUT" && path === "/market/me/avatar") {
        const [status, result] = setAvatar(user, await body(request));
        json(response, status, result);
      } else if (method === "DELETE" && path === "/market/me/avatar") {
        sql("DELETE FROM avatars WHERE user_id = ?").run(user.id);
        json(response, 200, { user: profile(user) });
      } else if (method === "PATCH" && path === "/market/me") {
        const [status, result] = updateProfile(user, await body(request));
        json(response, status, result);
      } else if (method === "POST" && path === "/market/me/watchlist") {
        // The stars a visitor set before signing in join the account's watchlist.
        const { ids } = await body(request);
        for (const id of (Array.isArray(ids) ? ids : []).slice(0, WATCH_LIMIT)) if (typeof id === "string" && COIN.test(id)) addWatch(user.id, id);
        json(response, 200, { watchlist: watchlist(user.id) });
      } else if (watchMatch && COIN.test(watchMatch[1]) && (method === "PUT" || method === "DELETE")) {
        if (method === "PUT" && !addWatch(user.id, watchMatch[1])) return json(response, 409, { error: "watchlist is full" }), true;
        if (method === "DELETE") sql("DELETE FROM watchlist WHERE user_id = ? AND coin_id = ?").run(user.id, watchMatch[1]);
        json(response, 200, { watchlist: watchlist(user.id) });
      } else {
        json(response, 404, { error: "not found" });
      }
    } catch (error) {
      json(response, error?.status ?? 500, { error: error?.status ? error.message : "server error" });
    }
    return true;
  }

  return { handle, enabled, db, alertCoins: alerts.coins, checkAlerts: alerts.check, labelFor: labels.labelFor, close: () => db.close() };
}
