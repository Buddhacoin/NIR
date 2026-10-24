import assert from "node:assert/strict";
import test from "node:test";

import { createAccounts, readCookie } from "../blockchain/market-accounts.mjs";
import { createMarketService } from "../blockchain/market-service.mjs";

const ORIGIN = "https://markets.example";

// A market service with accounts; signIn(name) signs a new Google account in and returns its cookie.
async function start() {
  const clock = { now: Date.UTC(2026, 9, 24, 12) };
  let next = { sub: "", nonce: "" };
  const accounts = createAccounts({ file: ":memory:", clientId: "c", clientSecret: "s", publicUrl: ORIGIN, now: () => clock.now,
    admins: ["athena@olympus.example"],
    post: async () => ({ id_token: `x.${Buffer.from(JSON.stringify({ iss: "accounts.google.com", aud: "c",
      exp: clock.now / 1000 + 600, nonce: next.nonce, sub: next.sub, email: `${next.sub}@olympus.example`,
      email_verified: true })).toString("base64url")}.y` }) });
  const service = createMarketService({ fetch: async () => { throw new Error("offline"); }, accounts });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  async function signIn(sub) {
    const google = new URL((await fetch(`${base}/market/auth/google`, { redirect: "manual" })).headers.get("location"));
    next = { sub, nonce: google.searchParams.get("nonce") };
    const back = await fetch(`${base}/market/auth/google/callback?code=c&state=${google.searchParams.get("state")}`, { redirect: "manual" });
    return readCookie(back.headers.get("set-cookie"), "__Host-nir_session");
  }
  const call = async (path, { cookie, method = "GET", body } = {}) => {
    const response = await fetch(`${base}${path}`, { method,
      headers: { ...(cookie ? { cookie: `__Host-nir_session=${cookie}` } : {}), ...(method === "GET" ? {} : { origin: ORIGIN }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { clock, signIn, call, stop: () => new Promise((resolve) => service.server.close(resolve)) };
}

test("comments: post, reply one level deep, like, sort, show on the profile and delete", async () => {
  const app = await start();
  try {
    const zeus = await app.signIn("zeus");
    const hera = await app.signIn("hera");
    assert.equal((await app.call("/market/coin/bitcoin/comments", { method: "POST", body: { body: "hi" } })).status, 401);
    const first = await app.call("/market/coin/bitcoin/comments", { cookie: zeus, method: "POST", body: { body: "  Thunder ahead.\r\n\r\n\r\nUp!  ", side: "rise" } });
    assert.equal(first.status, 201);
    assert.equal(first.data.comment.body, "Thunder ahead.\n\nUp!");
    assert.equal(first.data.comment.side, "rise");
    assert.equal((await app.call("/market/coin/bitcoin/comments", { cookie: zeus, method: "POST", body: { body: "again" } })).status, 429,
      "one comment every 20 seconds");
    app.clock.now += 21_000;
    const second = await app.call("/market/coin/bitcoin/comments", { cookie: hera, method: "POST", body: { body: "Calm seas.", side: "fall" } });
    app.clock.now += 21_000;
    const reply = await app.call("/market/coin/bitcoin/comments", { cookie: hera, method: "POST",
      body: { body: "Agreed?", parentId: first.data.comment.id } });
    app.clock.now += 21_000;
    const nested = await app.call("/market/coin/bitcoin/comments", { cookie: zeus, method: "POST",
      body: { body: "Yes.", parentId: reply.data.comment.id } });
    assert.equal(nested.data.comment.parentId, first.data.comment.id, "a reply to a reply joins the same thread");
    for (const bad of [{ body: "" }, { body: "x".repeat(1001) }, { body: "ok", side: "moon" }]) {
      app.clock.now += 21_000;
      assert.equal((await app.call("/market/coin/bitcoin/comments", { cookie: zeus, method: "POST", body: bad })).status, 400);
    }

    assert.equal((await app.call(`/market/comments/${second.data.comment.id}/like`, { cookie: zeus, method: "PUT" })).data.likes, 1);
    const latest = (await app.call("/market/coin/bitcoin/comments", { cookie: zeus })).data.comments;
    assert.deepEqual(latest.map((comment) => comment.body), ["Calm seas.", "Thunder ahead.\n\nUp!"]);
    assert.deepEqual(latest[1].replies.map((comment) => comment.body), ["Agreed?", "Yes."]);
    assert.equal(latest[0].liked, true);
    assert.equal(latest[1].mine, true);
    assert.equal(JSON.stringify(latest).includes("olympus"), false, "no emails in comments");
    const top = (await app.call("/market/coin/bitcoin/comments?sort=top")).data.comments;
    assert.equal(top[0].likes, 1);

    const me = (await app.call("/market/me", { cookie: zeus })).data.user.username;
    const profile = (await app.call(`/market/u/${me}`)).data;
    assert.deepEqual(profile.comments.map((comment) => comment.coinId), ["bitcoin", "bitcoin"]);
    assert.ok(profile.activity.some((item) => item.kind === "comment" && item.coinId === "bitcoin"));

    assert.equal((await app.call(`/market/comments/${second.data.comment.id}`, { cookie: zeus, method: "DELETE" })).status, 403);
    assert.equal((await app.call(`/market/comments/${first.data.comment.id}`, { cookie: zeus, method: "DELETE" })).status, 200);
    assert.deepEqual((await app.call("/market/coin/bitcoin/comments")).data.comments.map((comment) => comment.body), ["Calm seas."],
      "deleting a comment removes its replies");
  } finally { await app.stop(); }
});

test("three reports hide a comment; a moderator can remove anything", async () => {
  const app = await start();
  try {
    const writer = await app.signIn("ares");
    const posted = (await app.call("/market/coin/bitcoin/comments", { cookie: writer, method: "POST", body: { body: "Spam spam" } })).data.comment;
    assert.equal((await app.call(`/market/comments/${posted.id}/report`, { cookie: writer, method: "POST" })).status, 400);
    for (const reader of ["apollo", "artemis", "hermes"]) {
      const cookie = await app.signIn(reader);
      await app.call(`/market/comments/${posted.id}/report`, { cookie, method: "POST" });
    }
    assert.deepEqual((await app.call("/market/coin/bitcoin/comments")).data.comments, []);

    const moderator = await app.signIn("athena");
    app.clock.now += 21_000;
    const other = (await app.call("/market/coin/bitcoin/comments", { cookie: writer, method: "POST", body: { body: "Rude." } })).data.comment;
    assert.equal((await app.call(`/market/comments/${other.id}`, { cookie: moderator, method: "DELETE" })).status, 200);
    assert.equal((await app.call("/market/coin/..%2Fx/comments")).status, 404);
  } finally { await app.stop(); }
});

test("the rise-or-fall vote counts one vote per account per coin per day", async () => {
  const app = await start();
  try {
    const zeus = await app.signIn("zeus");
    const hera = await app.signIn("hera");
    assert.deepEqual((await app.call("/market/coin/bitcoin/sentiment")).data, { rise: 0, fall: 0, mine: null, day: "2026-10-24" });
    await app.call("/market/coin/bitcoin/sentiment", { cookie: zeus, method: "POST", body: { side: "rise" } });
    const again = await app.call("/market/coin/bitcoin/sentiment", { cookie: zeus, method: "POST", body: { side: "fall" } });
    assert.deepEqual([again.data.rise, again.data.fall, again.data.mine], [1, 0, "rise"], "a second vote the same day changes nothing");
    await app.call("/market/coin/bitcoin/sentiment", { cookie: hera, method: "POST", body: { side: "fall" } });
    assert.equal((await app.call("/market/coin/bitcoin/sentiment", { cookie: hera, method: "POST", body: { side: "up" } })).status, 400);
    assert.deepEqual((await app.call("/market/coin/bitcoin/sentiment")).data, { rise: 1, fall: 1, mine: null, day: "2026-10-24" });
    app.clock.now += 86_400_000;
    assert.deepEqual((await app.call("/market/coin/bitcoin/sentiment", { cookie: zeus })).data, { rise: 0, fall: 0, mine: null, day: "2026-10-25" });
  } finally { await app.stop(); }
});
