import assert from "node:assert/strict";
import test from "node:test";

import { checkClaims, createAccounts, readCookie } from "../blockchain/market-accounts.mjs";
import { createMarketService } from "../blockchain/market-service.mjs";

const ORIGIN = "https://markets.example";
const token = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

async function start({ clock = { now: 1_700_000_000_000 }, claims = {} } = {}) {
  const posts = [];
  const accounts = createAccounts({ file: ":memory:", clientId: "client-1", clientSecret: "secret-1", publicUrl: ORIGIN,
    now: () => clock.now,
    post: async (url, form) => {
      posts.push({ url, form });
      return { id_token: token({ iss: "https://accounts.google.com", aud: "client-1", exp: clock.now / 1000 + 600,
        sub: "google-zeus", email: "zeus@olympus.example", email_verified: true, nonce: posts.nonce, ...claims }) };
    } });
  const service = createMarketService({ fetch: async () => { throw new Error("offline"); }, accounts });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  // Signs in through the full redirect dance and returns the session cookie.
  async function signIn() {
    const begin = await fetch(`${base}/market/auth/google?return=/coin/bitcoin`, { redirect: "manual" });
    assert.equal(begin.status, 302);
    const google = new URL(begin.headers.get("location"));
    assert.equal(google.origin, "https://accounts.google.com");
    assert.equal(google.searchParams.get("code_challenge_method"), "S256");
    assert.equal(google.searchParams.get("redirect_uri"), `${ORIGIN}/market/auth/google/callback`);
    posts.nonce = google.searchParams.get("nonce");
    const back = await fetch(`${base}/market/auth/google/callback?code=c1&state=${google.searchParams.get("state")}`, { redirect: "manual" });
    return { back, cookie: readCookie(back.headers.get("set-cookie"), "__Host-nir_session") };
  }
  const call = (path, { cookie, method = "GET", body, origin = ORIGIN } = {}) => fetch(`${base}${path}`, {
    method, headers: { ...(cookie ? { cookie: `__Host-nir_session=${cookie}` } : {}), ...(method === "GET" ? {} : { origin }),
      "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const stop = () => new Promise((resolve) => service.server.close(resolve));
  return { base, posts, signIn, call, stop, clock };
}

test("Google sign-in creates an account, a session cookie and a public profile", async () => {
  const app = await start();
  try {
    assert.deepEqual(await (await app.call("/market/me")).json(), { signIn: true, user: null });
    const { back, cookie } = await app.signIn();
    assert.equal(back.status, 302);
    assert.equal(back.headers.get("location"), "/coin/bitcoin");
    assert.match(back.headers.get("set-cookie"), /HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
    assert.equal(app.posts[0].form.code_verifier.length, 43);
    assert.equal(app.posts[0].form.client_secret, "secret-1");
    const me = await (await app.call("/market/me", { cookie })).json();
    assert.match(me.user.username, /^user\d{6}$/);
    assert.deepEqual(me.watchlist, []);
    assert.equal(JSON.stringify(me).includes("olympus"), false, "the email never leaves the server");
    assert.deepEqual(await (await app.call("/market/stats")).json(), { users: 1 });

    // The same Google account signs in to the same profile.
    const again = await app.signIn();
    assert.equal((await (await app.call("/market/me", { cookie: again.cookie })).json()).user.username, me.user.username);

    const visitor = await (await app.call(`/market/u/${me.user.username}`)).json();
    assert.equal(visitor.own, false);
    assert.deepEqual(visitor.activity.map((item) => item.kind), ["joined"]);
    assert.equal((await app.call("/market/u/nobody_here")).status, 404);

    const out = await app.call("/market/auth/logout", { cookie, method: "POST" });
    assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await (await app.call("/market/me", { cookie })).json()).user, null);
  } finally { await app.stop(); }
});

test("the watchlist and profile change only for the signed-in owner, from this site", async () => {
  const app = await start();
  try {
    const { cookie } = await app.signIn();
    assert.equal((await app.call("/market/me/watchlist/bitcoin", { method: "PUT" })).status, 401);
    assert.equal((await app.call("/market/me/watchlist/bitcoin", { cookie, method: "PUT", origin: "https://evil.example" })).status, 403);
    assert.deepEqual((await (await app.call("/market/me/watchlist/bitcoin", { cookie, method: "PUT" })).json()).watchlist, ["bitcoin"]);
    // Stars set before signing in are merged; junk ids are dropped.
    const merged = await (await app.call("/market/me/watchlist", { cookie, method: "POST",
      body: { ids: ["ethereum", "bitcoin", "../x", 7] } })).json();
    assert.deepEqual(merged.watchlist, ["bitcoin", "ethereum"]);
    assert.deepEqual((await (await app.call("/market/me/watchlist/bitcoin", { cookie, method: "DELETE" })).json()).watchlist, ["ethereum"]);

    const renamed = await (await app.call("/market/me", { cookie, method: "PATCH",
      body: { username: "Zeus_Olympus", displayName: "  Zeus  ", bio: "Thunder." } })).json();
    assert.deepEqual([renamed.user.username, renamed.user.displayName, renamed.user.bio], ["zeus_olympus", "Zeus", "Thunder."]);
    assert.equal((await app.call("/market/me", { cookie, method: "PATCH", body: { username: "athena" } })).status, 429);
    assert.equal((await app.call("/market/me", { cookie, method: "PATCH", body: { bio: "x".repeat(251) } })).status, 400);
    assert.equal((await app.call("/market/me", { cookie, method: "PATCH", body: { displayName: "" } })).status, 400);
    app.clock.now += 8 * 86_400_000;
    assert.equal((await app.call("/market/me", { cookie, method: "PATCH", body: { username: "a b" } })).status, 400);

    const own = await (await app.call("/market/u/zeus_olympus", { cookie })).json();
    assert.equal(own.own, true);
    assert.deepEqual(own.activity.map((item) => item.kind), ["profile", "watch", "watch", "joined"]);
    const visitor = await (await app.call("/market/u/zeus_olympus")).json();
    assert.deepEqual(visitor.activity.map((item) => item.kind), ["joined"], "the watchlist stays private");
  } finally { await app.stop(); }
});

test("a forged, replayed or wrong ID token never signs anyone in", async () => {
  const now = 1_700_000_000_000;
  const good = { iss: "accounts.google.com", aud: "client-1", exp: now / 1000 + 60, nonce: "n1", sub: "s", email_verified: true };
  assert.equal(checkClaims(good, { clientId: "client-1", nonce: "n1", now }).sub, "s");
  for (const [change, message] of [[{ iss: "evil" }, /issuer/], [{ aud: "client-2" }, /audience/], [{ exp: now / 1000 - 1 }, /expired/],
    [{ nonce: "n2" }, /nonce/], [{ email_verified: false }, /verified/], [{ sub: "" }, /subject/]]) {
    assert.throws(() => checkClaims({ ...good, ...change }, { clientId: "client-1", nonce: "n1", now }), message);
  }
  const app = await start({ claims: { aud: "someone-else" } });
  try {
    const { back, cookie } = await app.signIn();
    assert.equal(back.headers.get("location"), "/?signin=failed");
    assert.equal(cookie, null);
    // An unknown or reused state goes nowhere.
    const replay = await fetch(`${app.base}/market/auth/google/callback?code=c&state=made-up`, { redirect: "manual" });
    assert.equal(replay.headers.get("location"), "/?signin=failed");
    const open = await fetch(`${app.base}/market/auth/google?return=//evil.example`, { redirect: "manual" });
    assert.equal(open.status, 302);
  } finally { await app.stop(); }
});

test("without Google keys the site says sign-in is off", async () => {
  const accounts = createAccounts({ file: ":memory:" });
  const service = createMarketService({ fetch: async () => { throw new Error("offline"); }, accounts });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/market/me`)).json(), { signIn: false, user: null });
    assert.equal((await fetch(`${base}/market/auth/google`, { redirect: "manual" })).status, 503);
  } finally { await new Promise((resolve) => service.server.close(resolve)); }
});

test("deleting an account removes its data and signs it out", async () => {
  const app = await start();
  try {
    const { cookie } = await app.signIn();
    await app.call("/market/me/watchlist/bitcoin", { cookie, method: "PUT" });
    const comment = await app.call("/market/coin/bitcoin/comments", { cookie, method: "POST", body: { body: "Bye." } });
    assert.equal(comment.status, 201);
    await app.call("/market/coin/bitcoin/sentiment", { cookie, method: "POST", body: { side: "rise" } });
    const name = (await (await app.call("/market/me", { cookie })).json()).user.username;
    assert.equal((await app.call("/market/me", { method: "DELETE", origin: "https://evil.example", cookie })).status, 403);
    const gone = await app.call("/market/me", { cookie, method: "DELETE" });
    assert.equal(gone.status, 200);
    assert.match(gone.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await (await app.call("/market/me", { cookie })).json()).user, null);
    assert.equal((await app.call(`/market/u/${name}`)).status, 404);
    assert.deepEqual((await (await app.call("/market/coin/bitcoin/comments")).json()).comments, []);
    const vote = await (await app.call("/market/coin/bitcoin/sentiment")).json();
    assert.equal(vote.rise, 0);
    // Signing in again with the same Google account starts a fresh account.
    const again = await app.signIn();
    assert.notEqual((await (await app.call("/market/me", { cookie: again.cookie })).json()).user, null);
  } finally { await app.stop(); }
});
