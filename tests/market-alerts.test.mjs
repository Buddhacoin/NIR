import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { pushEndpointAllowed } from "../blockchain/market-alerts.mjs";
import { createAccounts, readCookie } from "../blockchain/market-accounts.mjs";
import { createVapidKeys, encryptPayload, vapidAuthorization } from "../blockchain/market-push.mjs";
import { createMarketService } from "../blockchain/market-service.mjs";

const ORIGIN = "https://markets.example";
const NOW = 1_700_000_000_000;
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

// A browser's side of Web Push: its keys, and RFC 8291 decryption of what arrives.
function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const keys = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") };
  function decrypt(body) {
    const salt = body.subarray(0, 16);
    const idLength = body[20];
    const sender = body.subarray(21, 21 + idLength);
    const shared = ecdh.computeSecret(sender);
    const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), sender, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
    const data = body.subarray(21 + idLength);
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(data.subarray(-16));
    const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
    assert.equal(plain.at(-1), 2, "a single last record");
    return JSON.parse(plain.subarray(0, -1).toString("utf8"));
  }
  return { keys, decrypt };
}

test("Web Push messages are encrypted for the browser alone and signed with the server's VAPID key", () => {
  const phone = browser();
  const body = encryptPayload({ keys: phone.keys }, JSON.stringify({ title: "Zeus" }));
  assert.equal(body.readUInt32BE(16), 4096);
  assert.deepEqual(phone.decrypt(body), { title: "Zeus" });
  assert.throws(() => browser().decrypt(body), "another browser cannot read it");

  const keys = createVapidKeys();
  const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "https://markets.example", NOW);
  const [, token, publicKey] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(publicKey, keys.publicKey);
  const [head, claims, signature] = token.split(".");
  const point = Buffer.from(publicKey, "base64url");
  const key = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256",
    x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") } });
  assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
  const payload = JSON.parse(Buffer.from(claims, "base64url"));
  assert.equal(payload.aud, "https://fcm.googleapis.com");
  assert.equal(payload.exp, NOW / 1000 + 12 * 3600);

  assert.equal(pushEndpointAllowed("https://fcm.googleapis.com/fcm/send/abc"), true);
  assert.equal(pushEndpointAllowed("https://web.push.apple.com/abc"), true);
  for (const bad of ["http://fcm.googleapis.com/x", "https://evil.example/x", "https://fcm.googleapis.com.evil.example/x",
    "https://fcm.googleapis.com:8443/x", "https://127.0.0.1/x", "not a url"]) assert.equal(pushEndpointAllowed(bad), false, bad);
});

async function start() {
  const state = { pushes: [], status: 201 };
  const token = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
  const accounts = createAccounts({ file: ":memory:", clientId: "client-1", clientSecret: "secret-1", publicUrl: ORIGIN, now: () => NOW,
    post: async () => ({ id_token: token({ iss: "https://accounts.google.com", aud: "client-1", exp: NOW / 1000 + 600,
      sub: state.sub, email: `${state.sub}@olympus.example`, email_verified: true, nonce: state.nonce }) }),
    pushFetch: async (url, options) => { state.pushes.push({ url, ...options }); return new Response(null, { status: state.status }); } });
  const service = createMarketService({ fetch: async () => { throw new Error("offline"); }, accounts });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  async function signIn(sub) {
    state.sub = sub;
    const google = new URL((await fetch(`${base}/market/auth/google`, { redirect: "manual" })).headers.get("location"));
    state.nonce = google.searchParams.get("nonce");
    const back = await fetch(`${base}/market/auth/google/callback?code=c&state=${google.searchParams.get("state")}`, { redirect: "manual" });
    return readCookie(back.headers.get("set-cookie"), "__Host-nir_session");
  }
  const call = async (path, { cookie, method = "GET", body, origin = ORIGIN } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(cookie ? { cookie: `__Host-nir_session=${cookie}` } : {}),
      ...(method === "GET" ? {} : { origin }), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const stop = () => new Promise((resolve) => service.server.close(resolve));
  return { state, accounts, signIn, call, stop };
}

const btc = { coinId: "bitcoin", name: "Bitcoin", symbol: "btc", lang: "en" };

test("price alerts fire once per crossing, land in the bell and in every browser that turned notifications on", async () => {
  const app = await start();
  try {
    assert.equal((await app.call("/market/me/alerts")).status, 401);
    const zeus = await app.signIn("zeus");
    const empty = await app.call("/market/me/alerts", { cookie: zeus });
    assert.deepEqual(empty.data.alerts, []);
    assert.equal(Buffer.from(empty.data.push.key, "base64url").length, 65);

    for (const bad of [{ kind: "maybe" }, { value: 0 }, { value: "x" }, { coinId: "../x" }, { name: "" }, { kind: "rise", value: 5000 }]) {
      assert.equal((await app.call("/market/me/alerts", { cookie: zeus, method: "POST", body: { ...btc, kind: "above", value: 1, ...bad } })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await app.call("/market/me/alerts", { cookie: zeus, method: "POST", origin: "https://evil.example", body: { ...btc, kind: "above", value: 1 } })).status, 403);

    const once = (await app.call("/market/me/alerts", { cookie: zeus, method: "POST", body: { ...btc, kind: "above", value: 90_000 } })).data.alerts[0];
    await app.call("/market/me/alerts", { cookie: zeus, method: "POST", body: { ...btc, kind: "fall", value: 5, repeat: true, lang: "ru" } });

    // Only addresses of real browser push services are accepted.
    const phone = browser();
    assert.equal((await app.call("/market/me/push", { cookie: zeus, method: "POST", body: { endpoint: "https://evil.example/x", keys: phone.keys } })).status, 400);
    assert.equal((await app.call("/market/me/push", { cookie: zeus, method: "POST", body: { endpoint: "https://fcm.googleapis.com/fcm/send/z1", keys: { p256dh: "x", auth: "y" } } })).status, 400);
    const added = await app.call("/market/me/push", { cookie: zeus, method: "POST", body: { endpoint: "https://fcm.googleapis.com/fcm/send/z1", keys: phone.keys } });
    assert.equal(added.data.push.devices, 1);

    assert.deepEqual(app.accounts.alertCoins(), ["bitcoin"]);
    assert.equal(await app.accounts.checkAlerts(new Map([["bitcoin", { price: 85_000, change24h: -1 }]])), 0);
    assert.equal(await app.accounts.checkAlerts(new Map([["bitcoin", { price: 91_000, change24h: 2 }]])), 1);
    assert.equal(app.state.pushes.length, 1);
    const push = app.state.pushes[0];
    assert.equal(push.url, "https://fcm.googleapis.com/fcm/send/z1");
    assert.equal(push.headers["content-encoding"], "aes128gcm");
    assert.match(push.headers.authorization, /^vapid t=.+, k=/);
    const note = phone.decrypt(push.body);
    assert.equal(note.title, "Bitcoin is above $90,000");
    assert.match(note.body, /^Now: \$91,000 \(\+2% in 24h\)$/);
    assert.equal(note.url, "/coin/bitcoin");

    // A one-time alert switches off; the repeating one fires on each new fall, not every minute.
    const prices = (change24h) => new Map([["bitcoin", { price: 80_000, change24h }]]);
    assert.equal(await app.accounts.checkAlerts(prices(-6)), 1);
    assert.equal(await app.accounts.checkAlerts(prices(-7)), 0);
    assert.equal(await app.accounts.checkAlerts(prices(-1)), 0);
    assert.equal(await app.accounts.checkAlerts(prices(-5.5)), 1);
    const page = await app.call("/market/me/alerts", { cookie: zeus });
    assert.equal(page.data.alerts.find((alert) => alert.id === once.id).active, false);
    assert.equal(page.data.events[0].title, "Bitcoin упала на 5% за 24 ч");
    assert.equal(page.data.unseen, 3);
    assert.equal((await app.call("/market/me", { cookie: zeus })).data.alertsUnseen, 3);
    assert.equal((await app.call("/market/me/alerts/seen", { cookie: zeus, method: "POST" })).data.unseen, 0);

    // Switched back on, the one-time alert is armed again.
    await app.call(`/market/me/alerts/${once.id}`, { cookie: zeus, method: "PUT", body: { active: true } });
    assert.equal(await app.accounts.checkAlerts(new Map([["bitcoin", { price: 95_000, change24h: 0 }]])), 1);

    // Another account sees none of it and cannot touch it.
    const athena = await app.signIn("athena");
    assert.deepEqual((await app.call("/market/me/alerts", { cookie: athena })).data.events, []);
    assert.equal((await app.call(`/market/me/alerts/${once.id}`, { cookie: athena, method: "DELETE" })).status, 404);

    // A browser that unsubscribed (410) is dropped on the next firing.
    app.state.status = 410;
    await app.call(`/market/me/alerts/${once.id}`, { cookie: zeus, method: "PUT", body: { active: true } });
    await app.accounts.checkAlerts(new Map([["bitcoin", { price: 95_000, change24h: 0 }]]));
    assert.equal((await app.call("/market/me/alerts", { cookie: zeus })).data.push.devices, 0);

    assert.equal((await app.call(`/market/me/alerts/${once.id}`, { cookie: zeus, method: "DELETE" })).data.alerts.length, 1);
    await app.call("/market/me", { cookie: zeus, method: "DELETE" });
    assert.deepEqual(app.accounts.alertCoins(), []);
  } finally { await app.stop(); }
});

test("the market service checks alerts after each refresh and prices coins outside the top hundred in one request", async () => {
  const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/market/${name}`, import.meta.url), "utf8"));
  const asked = [];
  const checked = [];
  const accounts = {
    handle: async () => false,
    alertCoins: () => ["bitcoin", "olympus-token"],
    checkAlerts: async (prices) => { checked.push(prices); },
  };
  const service = createMarketService({ now: () => NOW, accounts, fetch: async (url) => {
    asked.push(url);
    if (url.includes("ids=")) return [{ id: "olympus-token", current_price: 2.5, price_change_percentage_24h: 4 }];
    for (const [key, file] of [["coins/markets", "coins.json"], ["/global", "global.json"], ["search/trending", "trending.json"], ["fng", "fng.json"]]) {
      if (url.includes(key)) return fixture(file);
    }
    throw new Error("unexpected");
  } });
  await service.refresh();
  assert.equal(asked.filter((url) => url.includes("ids=")).length, 1);
  assert.match(asked.find((url) => url.includes("ids=")), /ids=olympus-token&/);
  assert.equal(checked.length, 1);
  assert.equal(checked[0].get("bitcoin").price, 80183.42);
  assert.deepEqual(checked[0].get("olympus-token"), { price: 2.5, change24h: 4 });
});
