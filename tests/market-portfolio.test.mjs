import assert from "node:assert/strict";
import test from "node:test";

import { createAccounts, readCookie } from "../blockchain/market-accounts.mjs";
import { createMarketService } from "../blockchain/market-service.mjs";

const ORIGIN = "https://markets.example";
const token = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const NOW = 1_700_000_000_000;

async function start() {
  const state = {};
  const accounts = createAccounts({ file: ":memory:", clientId: "client-1", clientSecret: "secret-1", publicUrl: ORIGIN, now: () => NOW,
    post: async () => ({ id_token: token({ iss: "https://accounts.google.com", aud: "client-1", exp: NOW / 1000 + 600,
      sub: state.sub, email: `${state.sub}@olympus.example`, email_verified: true, nonce: state.nonce }) }) });
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
  const call = (path, { cookie, method = "GET", body, origin = ORIGIN } = {}) => fetch(`${base}${path}`, {
    method, headers: { ...(cookie ? { cookie: `__Host-nir_session=${cookie}` } : {}), ...(method === "GET" ? {} : { origin }),
      "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const stop = () => new Promise((resolve) => service.server.close(resolve));
  return { signIn, call, stop };
}

const buy = { coinId: "bitcoin", kind: "buy", amount: 0.5, price: 60_000, fee: 10, at: NOW - 86_400_000, note: "First" };

test("a portfolio keeps its owner's records, private and checked", async () => {
  const app = await start();
  try {
    assert.equal((await app.call("/market/me/portfolio")).status, 401);
    const zeus = await app.signIn("zeus");
    assert.deepEqual((await (await app.call("/market/me/portfolio", { cookie: zeus })).json()).transactions, []);
    assert.equal((await app.call("/market/me/portfolio", { cookie: zeus, method: "POST", body: buy, origin: "https://evil.example" })).status, 403);
    const added = await app.call("/market/me/portfolio", { cookie: zeus, method: "POST", body: buy });
    assert.equal(added.status, 201);
    const [record] = (await added.json()).transactions;
    assert.deepEqual({ ...record, id: undefined }, { ...buy, id: undefined });

    for (const bad of [{ coinId: "../x" }, { kind: "gift" }, { amount: 0 }, { amount: "lots" }, { price: -1 }, { fee: -1 },
      { at: NOW + 3 * 86_400_000 }, { at: 0 }, { note: "x".repeat(201) }]) {
      assert.equal((await app.call("/market/me/portfolio", { cookie: zeus, method: "POST", body: { ...buy, ...bad } })).status, 400, JSON.stringify(bad));
    }

    // Records kept in the browser before signing in arrive together; one bad record stops the batch.
    const batch = [{ ...buy, kind: "sell", amount: 0.2, price: 70_000 }, { ...buy, coinId: "ethereum", amount: 2, price: 3000 }];
    assert.equal((await app.call("/market/me/portfolio", { cookie: zeus, method: "POST", body: { transactions: [...batch, { kind: "x" }] } })).status, 400);
    const merged = await (await app.call("/market/me/portfolio", { cookie: zeus, method: "POST", body: { transactions: batch } })).json();
    assert.equal(merged.transactions.length, 3);

    const edited = await (await app.call(`/market/me/portfolio/${record.id}`, { cookie: zeus, method: "PUT", body: { ...buy, amount: 1 } })).json();
    assert.equal(edited.transactions.find((item) => item.id === record.id).amount, 1);

    // Another account neither sees nor changes these records, and the public profile shows nothing of them.
    const athena = await app.signIn("athena");
    assert.deepEqual((await (await app.call("/market/me/portfolio", { cookie: athena })).json()).transactions, []);
    assert.equal((await app.call(`/market/me/portfolio/${record.id}`, { cookie: athena, method: "DELETE" })).status, 404);
    const me = await (await app.call("/market/me", { cookie: zeus })).json();
    const profile = await (await app.call(`/market/u/${me.user.username}`)).json();
    assert.equal(JSON.stringify(profile).includes("60000"), false);

    const left = await (await app.call(`/market/me/portfolio/${record.id}`, { cookie: zeus, method: "DELETE" })).json();
    assert.equal(left.transactions.length, 2);

    // Deleting the account removes its portfolio.
    await app.call("/market/me", { cookie: zeus, method: "DELETE" });
    const again = await app.signIn("zeus");
    assert.deepEqual((await (await app.call("/market/me/portfolio", { cookie: again })).json()).transactions, []);
  } finally { await app.stop(); }
});
