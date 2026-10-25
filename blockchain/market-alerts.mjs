// NIR Markets price alerts: "tell me when a coin goes above or below a price,
// or rises or falls by some percent in 24 hours". Part of the accounts
// service (market-accounts.mjs), sharing its database and checks.
//
// The market service hands over fresh prices once a minute (check()). An
// alert fires when its condition becomes true: a one-time alert then switches
// off; a repeating one waits until the condition is false again, so it fires
// once per crossing rather than every minute. A firing is kept for the
// visitor's alerts page and the bell in the header, and is sent as a Web Push
// notification (market-push.mjs) to every browser the visitor turned
// notifications on in. Alerts are private.
//
// Limits: 50 alerts and 10 browsers per account; the last 100 firings are kept.
// Push endpoints must belong to a known browser push service, so the server
// never sends requests anywhere a visitor chooses.
import { createVapidKeys, sendPush } from "./market-push.mjs";

const COIN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const KINDS = new Set(["above", "below", "rise", "fall"]);
const ALERT_LIMIT = 50;
const DEVICE_LIMIT = 10;
const KEEP_EVENTS = 100;
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/, /^web\.push\.apple\.com$/, /(^|\.)push\.apple\.com$/];

const words = {
  ru: { above: "выше", below: "ниже", rise: "выросла на", fall: "упала на", now: "Сейчас", day: "за 24 ч" },
  en: { above: "is above", below: "is below", rise: "rose", fall: "fell", now: "Now", day: "in 24h" },
};

export function pushEndpointAllowed(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !url.port && endpoint.length <= 1000 && PUSH_HOSTS.some((host) => host.test(url.hostname));
  } catch {
    return false;
  }
}

export function createAlerts({ db, now, publicUrl, fetch: post = fetch, send = sendPush }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, coin_id TEXT NOT NULL,
      name TEXT NOT NULL, symbol TEXT NOT NULL, kind TEXT NOT NULL, value REAL NOT NULL, repeat INTEGER NOT NULL,
      lang TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, armed INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, fired_at INTEGER);
    CREATE INDEX IF NOT EXISTS alerts_user ON alerts (user_id);
    CREATE TABLE IF NOT EXISTS alert_events (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, alert_id INTEGER,
      coin_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS alert_events_user ON alert_events (user_id, id);
    CREATE TABLE IF NOT EXISTS push_devices (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const sql = (text) => db.prepare(text);

  // The server's VAPID key pair, made on first start and kept with the accounts.
  let vapid = sql("SELECT value FROM settings WHERE key = 'vapid'").get();
  if (!vapid) {
    sql("INSERT INTO settings (key, value) VALUES ('vapid', ?)").run(JSON.stringify(createVapidKeys()));
    vapid = sql("SELECT value FROM settings WHERE key = 'vapid'").get();
  }
  const keys = JSON.parse(vapid.value);
  const subject = publicUrl.startsWith("https:") ? publicUrl : "mailto:markets@localhost";

  const list = (userId) => sql(`SELECT id, coin_id AS coinId, name, symbol, kind, value, repeat, active, created_at AS createdAt,
    fired_at AS firedAt FROM alerts WHERE user_id = ? ORDER BY id DESC`).all(userId)
    .map((row) => ({ ...row, repeat: Boolean(row.repeat), active: Boolean(row.active) }));
  const events = (userId) => sql(`SELECT id, coin_id AS coinId, title, body, at, seen FROM alert_events
    WHERE user_id = ? ORDER BY id DESC LIMIT 50`).all(userId).map((row) => ({ ...row, seen: Boolean(row.seen) }));
  const unseen = (userId) => sql("SELECT COUNT(*) AS n FROM alert_events WHERE user_id = ? AND seen = 0").get(userId).n;
  const devices = (userId) => sql("SELECT COUNT(*) AS n FROM push_devices WHERE user_id = ?").get(userId).n;
  const page = (userId) => ({ alerts: list(userId), events: events(userId), unseen: unseen(userId),
    push: { key: keys.publicKey, devices: devices(userId) } });

  // An alert from the page, checked field by field; returns [alert] or [null, error].
  function validate(input) {
    const alert = {
      coinId: typeof input?.coinId === "string" ? input.coinId : "",
      name: typeof input?.name === "string" ? input.name.replace(/\s+/g, " ").trim().slice(0, 60) : "",
      symbol: typeof input?.symbol === "string" ? input.symbol.trim().toUpperCase().slice(0, 20) : "",
      kind: input?.kind, value: Number(input?.value), repeat: input?.repeat === true,
      lang: input?.lang === "en" ? "en" : "ru",
    };
    if (!COIN.test(alert.coinId) || !alert.name || !alert.symbol) return [null, "unknown coin"];
    if (!KINDS.has(alert.kind)) return [null, "kind must be above, below, rise or fall"];
    const percent = alert.kind === "rise" || alert.kind === "fall";
    if (!Number.isFinite(alert.value) || alert.value <= 0 || alert.value > (percent ? 1000 : 1e12)) {
      return [null, percent ? "percent must be above 0 and at most 1000" : "price must be above 0"];
    }
    return [alert];
  }

  async function handle({ method, path, user, request, response, json, body }) {
    if (path === "/market/me/alerts" && method === "GET") return json(response, 200, page(user.id)), true;
    if (path === "/market/me/alerts" && method === "POST") {
      const [alert, error] = validate(await body(request));
      if (!alert) return json(response, 400, { error }), true;
      if (sql("SELECT COUNT(*) AS n FROM alerts WHERE user_id = ?").get(user.id).n >= ALERT_LIMIT) {
        return json(response, 409, { error: "too many alerts" }), true;
      }
      sql(`INSERT INTO alerts (user_id, coin_id, name, symbol, kind, value, repeat, lang, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(user.id, alert.coinId, alert.name, alert.symbol, alert.kind, alert.value, alert.repeat ? 1 : 0, alert.lang, now());
      return json(response, 201, page(user.id)), true;
    }
    if (path === "/market/me/alerts/seen" && method === "POST") {
      sql("UPDATE alert_events SET seen = 1 WHERE user_id = ?").run(user.id);
      return json(response, 200, page(user.id)), true;
    }
    if (path === "/market/me/push" && (method === "POST" || method === "DELETE")) {
      const input = await body(request);
      const endpoint = typeof input?.endpoint === "string" ? input.endpoint : "";
      if (!pushEndpointAllowed(endpoint)) return json(response, 400, { error: "not a browser push address" }), true;
      if (method === "DELETE") {
        sql("DELETE FROM push_devices WHERE endpoint = ? AND user_id = ?").run(endpoint, user.id);
        return json(response, 200, page(user.id)), true;
      }
      const p256dh = String(input?.keys?.p256dh ?? "");
      const auth = String(input?.keys?.auth ?? "");
      if (Buffer.from(p256dh, "base64url").length !== 65 || Buffer.from(auth, "base64url").length !== 16) {
        return json(response, 400, { error: "subscription keys are invalid" }), true;
      }
      // The same browser moves to whoever signs in on it.
      sql("DELETE FROM push_devices WHERE endpoint = ?").run(endpoint);
      if (devices(user.id) >= DEVICE_LIMIT) {
        sql("DELETE FROM push_devices WHERE id = (SELECT id FROM push_devices WHERE user_id = ? ORDER BY id LIMIT 1)").run(user.id);
      }
      sql("INSERT INTO push_devices (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)").run(user.id, endpoint, p256dh, auth, now());
      return json(response, 201, page(user.id)), true;
    }
    const match = /^\/market\/me\/alerts\/(\d{1,15})$/.exec(path);
    if (!match || (method !== "PUT" && method !== "DELETE")) return false;
    const id = Number(match[1]);
    if (!sql("SELECT 1 FROM alerts WHERE id = ? AND user_id = ?").get(id, user.id)) return json(response, 404, { error: "no such alert" }), true;
    if (method === "DELETE") sql("DELETE FROM alerts WHERE id = ?").run(id);
    else {
      const input = await body(request);
      if (typeof input?.active === "boolean" && Object.keys(input).length === 1) {
        // Switching an alert back on arms it again.
        sql("UPDATE alerts SET active = ?, armed = 1 WHERE id = ?").run(input.active ? 1 : 0, id);
      } else {
        const [alert, error] = validate(input);
        if (!alert) return json(response, 400, { error }), true;
        sql("UPDATE alerts SET coin_id = ?, name = ?, symbol = ?, kind = ?, value = ?, repeat = ?, lang = ?, active = 1, armed = 1 WHERE id = ?")
          .run(alert.coinId, alert.name, alert.symbol, alert.kind, alert.value, alert.repeat ? 1 : 0, alert.lang, id);
      }
    }
    return json(response, 200, page(user.id)), true;
  }

  // The coins any switched-on alert watches, for the market service to price.
  const coins = () => sql("SELECT DISTINCT coin_id AS id FROM alerts WHERE active = 1").all().map((row) => row.id);

  function message(alert, quote) {
    const text = words[alert.lang] ?? words.ru;
    const locale = alert.lang === "en" ? "en-US" : "ru-RU";
    const money = (value) => `$${value.toLocaleString(locale, { maximumSignificantDigits: value >= 1 ? Math.max(6, String(Math.floor(value)).length + 2) : 6 })}`;
    const percent = (value) => `${value.toLocaleString(locale, { maximumFractionDigits: 2 })}%`;
    const title = alert.kind === "above" || alert.kind === "below"
      ? `${alert.name} ${text[alert.kind]} ${money(alert.value)}`
      : `${alert.name} ${text[alert.kind]} ${percent(alert.value)} ${text.day}`;
    const change = Number.isFinite(quote.change24h) ? ` (${quote.change24h > 0 ? "+" : ""}${percent(quote.change24h)} ${text.day})` : "";
    return { title, body: `${text.now}: ${money(quote.price)}${change}` };
  }

  // Fresh prices, a Map of coin id → { price, change24h }; fires what has come true. Returns the number fired.
  async function check(prices) {
    const fired = [];
    for (const alert of sql("SELECT * FROM alerts WHERE active = 1").all()) {
      const quote = prices.get(alert.coin_id);
      if (!quote || !Number.isFinite(quote.price)) continue;
      const change = quote.change24h;
      const met = alert.kind === "above" ? quote.price >= alert.value
        : alert.kind === "below" ? quote.price <= alert.value
          : alert.kind === "rise" ? Number.isFinite(change) && change >= alert.value
            : Number.isFinite(change) && change <= -alert.value;
      if (!met) {
        if (!alert.armed) sql("UPDATE alerts SET armed = 1 WHERE id = ?").run(alert.id);
        continue;
      }
      if (!alert.armed) continue;
      sql("UPDATE alerts SET armed = 0, active = ?, fired_at = ? WHERE id = ?").run(alert.repeat ? 1 : 0, now(), alert.id);
      const { title, body } = message(alert, quote);
      sql("INSERT INTO alert_events (user_id, alert_id, coin_id, title, body, at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(alert.user_id, alert.id, alert.coin_id, title, body, now());
      sql(`DELETE FROM alert_events WHERE user_id = ? AND id NOT IN
        (SELECT id FROM alert_events WHERE user_id = ? ORDER BY id DESC LIMIT ${KEEP_EVENTS})`).run(alert.user_id, alert.user_id);
      fired.push({ userId: alert.user_id, title, body, url: `/coin/${alert.coin_id}` });
    }
    await Promise.all(fired.flatMap((note) => sql("SELECT * FROM push_devices WHERE user_id = ?").all(note.userId).map(async (device) => {
      const result = await send({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
        { title: note.title, body: note.body, url: note.url }, { keys, subject, fetch: post, now: now() });
      if (result === "gone") sql("DELETE FROM push_devices WHERE id = ?").run(device.id);
    })));
    return fired.length;
  }

  function forget(userId) {
    for (const table of ["alerts", "alert_events", "push_devices"]) sql(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
  }

  return { handle, coins, check, unseen, forget, publicKey: keys.publicKey };
}
