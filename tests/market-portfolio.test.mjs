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

test("portfolios are named folders of a visitor's records, private and checked", async () => {
  const app = await start();
  try {
    assert.equal((await app.call("/market/me/portfolio")).status, 401);
    const zeus = await app.signIn("zeus");
    assert.deepEqual(await (await app.call("/market/me/portfolio", { cookie: zeus })).json(), { portfolios: [], transactions: [] });

    // A folder is made with a name, and can come with the records kept in this browser before signing in.
    for (const bad of [{ name: "" }, { name: "x".repeat(41) }, { name: "Olympus", transactions: [{ kind: "x" }] }]) {
      assert.equal((await app.call("/market/me/portfolios", { cookie: zeus, method: "POST", body: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await app.call("/market/me/portfolios", { cookie: zeus, method: "POST", body: { name: "Olympus" }, origin: "https://evil.example" })).status, 403);
    const made = await app.call("/market/me/portfolios", { cookie: zeus, method: "POST", body: { name: "  Olympus   wallet ", transactions: [buy] } });
    assert.equal(made.status, 201);
    const first = await made.json();
    assert.equal(first.portfolios[0].name, "Olympus wallet");
    const olympus = first.created;
    assert.equal(first.transactions[0].portfolioId, olympus);
    const delphi = (await (await app.call("/market/me/portfolios", { cookie: zeus, method: "POST", body: { name: "Delphi" } })).json()).created;

    // Records: buys, sales and transfers of coins kept in a wallet elsewhere.
    const add = (body) => app.call("/market/me/portfolio", { cookie: zeus, method: "POST", body });
    for (const bad of [{ coinId: "../x" }, { kind: "gift" }, { amount: 0 }, { amount: "lots" }, { price: -1 }, { fee: -1 },
      { at: NOW + 3 * 86_400_000 }, { at: 0 }, { note: "x".repeat(201) }]) {
      assert.equal((await add({ portfolioId: delphi, ...buy, ...bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await add({ portfolioId: 999, ...buy })).status, 404);
    const transfer = await add({ portfolioId: delphi, coinId: "ethereum", kind: "in", amount: 3, at: NOW });
    assert.equal(transfer.status, 201);
    const moved = (await transfer.json()).transactions.find((item) => item.kind === "in");
    assert.deepEqual([moved.portfolioId, moved.price, moved.fee], [delphi, 0, 0]);
    await add({ portfolioId: delphi, transactions: [{ ...buy, kind: "out", amount: 1, coinId: "ethereum" }, { ...buy, coinId: "solana" }] });

    const edited = await (await app.call(`/market/me/portfolio/${moved.id}`, { cookie: zeus, method: "PUT", body: { ...buy, coinId: "ethereum", kind: "in", amount: 5 } })).json();
    assert.equal(edited.transactions.find((item) => item.id === moved.id).amount, 5);

    // Renaming, removing one coin from a folder, deleting a folder with its records.
    assert.equal((await app.call(`/market/me/portfolios/${delphi}`, { cookie: zeus, method: "PUT", body: { name: "" } })).status, 400);
    const renamed = await (await app.call(`/market/me/portfolios/${delphi}`, { cookie: zeus, method: "PUT", body: { name: "Delphi vault" } })).json();
    assert.equal(renamed.portfolios.find((item) => item.id === delphi).name, "Delphi vault");
    const trimmed = await (await app.call(`/market/me/portfolios/${delphi}/coins/ethereum`, { cookie: zeus, method: "DELETE" })).json();
    assert.deepEqual(trimmed.transactions.filter((item) => item.portfolioId === delphi).map((item) => item.coinId), ["solana"]);

    // Another account neither sees nor changes these, and the public profile shows nothing of them.
    const athena = await app.signIn("athena");
    assert.deepEqual(await (await app.call("/market/me/portfolio", { cookie: athena })).json(), { portfolios: [], transactions: [] });
    assert.equal((await app.call(`/market/me/portfolios/${olympus}`, { cookie: athena, method: "DELETE" })).status, 404);
    assert.equal((await app.call("/market/me/portfolio", { cookie: athena, method: "POST", body: { portfolioId: olympus, ...buy } })).status, 404);
    assert.equal((await app.call(`/market/me/portfolio/${moved.id}`, { cookie: athena, method: "DELETE" })).status, 404);
    const me = await (await app.call("/market/me", { cookie: zeus })).json();
    const profile = await (await app.call(`/market/u/${me.user.username}`)).json();
    assert.equal(JSON.stringify(profile).includes("Olympus"), false);

    const gone = await (await app.call(`/market/me/portfolios/${delphi}`, { cookie: zeus, method: "DELETE" })).json();
    assert.deepEqual(gone.portfolios.map((item) => item.id), [olympus]);
    assert.ok(gone.transactions.every((item) => item.portfolioId === olympus));

    // Deleting the account removes its portfolios.
    await app.call("/market/me", { cookie: zeus, method: "DELETE" });
    const again = await app.signIn("zeus");
    assert.deepEqual(await (await app.call("/market/me/portfolio", { cookie: again })).json(), { portfolios: [], transactions: [] });
  } finally { await app.stop(); }
});

test("records saved before portfolios existed join the account's first portfolio", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createPortfolio } = await import("../blockchain/market-portfolio.mjs");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE portfolio (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, coin_id TEXT NOT NULL, kind TEXT NOT NULL,
    amount REAL NOT NULL, price REAL NOT NULL, fee REAL NOT NULL DEFAULT 0, at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`);
  db.prepare("INSERT INTO portfolio (user_id, coin_id, kind, amount, price, at, created_at) VALUES (7, 'bitcoin', 'buy', 1, 100, ?, ?)").run(NOW, NOW);
  const portfolio = createPortfolio({ db, now: () => NOW });
  let answer;
  await portfolio.handle({ method: "GET", path: "/market/me/portfolio", user: { id: 7 }, request: null, response: null,
    json: (response, status, body) => { answer = body; }, body: async () => ({}) });
  assert.equal(answer.portfolios.length, 1);
  assert.equal(answer.transactions[0].portfolioId, answer.portfolios[0].id);
});
