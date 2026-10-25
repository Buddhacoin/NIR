import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { addressKind, createChain, party, units } from "../blockchain/market-chain.mjs";
import { createMarketService } from "../blockchain/market-service.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/chain/${name}`, import.meta.url), "utf8"));
const EXCHANGE = "0x28C6c06298d514Db089934071355E5743bf21d60";
const UTXO = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";

// Recorded explorer answers; `asked` lists every URL the service fetched.
function explorers({ fail = [] } = {}) {
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    if (fail.some((part) => url.includes(part))) throw Object.assign(new Error("down"), { status: 502 });
    if (url.includes("mempool.space/api/address/") && url.endsWith("/txs")) return fixture("utxo-txs.json");
    if (url.includes("mempool.space/api/address/")) return fixture("utxo-address.json");
    if (url.includes("/search?q=")) return fixture("search.json");
    if (url.includes("/coin-balance-history-by-day")) return fixture("history.json");
    if (url.includes("/token-balances")) return fixture("token-balances.json");
    if (/\/addresses\/0x[0-9a-fA-F]{40}\/token-transfers/.test(url)) return fixture("address-transfers.json");
    if (/\/addresses\/0x[0-9a-fA-F]{40}\/transactions/.test(url)) return fixture("transactions.json");
    if (/\/addresses\/0x[0-9a-fA-F]{40}$/.test(url)) return fixture("address.json");
    if (url.includes("/token-transfers?type=ERC-20")) return fixture("token-transfers.json");
    if (url.includes("/transactions?filter=validated")) return fixture("transactions.json");
    throw new Error(`unexpected ${url}`);
  };
  return { asked, get };
}

test("explorer answers become transfers with names, amounts and dollar values", () => {
  assert.equal(units("1500000", "6"), 1.5);
  assert.equal(units("5", "18"), 5e-18);
  assert.equal(units("12", 0), 12);
  assert.equal(units("-1", 6), null);
  assert.equal(units("1e9", 6), null);
  assert.equal(addressKind(EXCHANGE), "evm");
  assert.equal(addressKind(UTXO), "utxo");
  assert.equal(addressKind("0x123"), null);
  assert.equal(addressKind("../etc/passwd"), null);
  const named = party({ hash: EXCHANGE, ens_domain_name: null, name: "TetherToken", is_contract: true,
    metadata: { tags: [{ tagType: "name", name: "USDT Stablecoin" }, { tagType: "generic", name: "Stablecoin" }] } });
  assert.deepEqual(named, { address: EXCHANGE, name: "USDT Stablecoin", tags: ["Stablecoin"], contract: true });
  assert.equal(party({ hash: "not an address" }), null);
});

test("the feed merges token and coin transfers from every network, newest first, with a dollar floor", async () => {
  const { get } = explorers();
  const chain = createChain({ get, now: () => Date.UTC(2026, 9, 25, 18, 15) });
  const service = createMarketService({ fetch: async () => { throw new Error("offline"); }, chain });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const all = await (await fetch(`${base}/market/chain/feed`)).json();
    assert.deepEqual(all.networks, ["eth", "optimism"]);
    assert.ok(all.items.length >= 6);
    assert.ok(all.items.every((item, index) => index === 0 || all.items[index - 1].time >= item.time), "newest first");
    assert.ok(all.items.every((item) => item.token.symbol !== "?"));
    assert.equal(all.items.filter((item) => item.id.endsWith(":9999")).length, 0, "scam tokens are left out");
    const dai = all.items.find((item) => item.token.symbol === "DAI" && item.chain === "eth");
    assert.ok(Math.abs(dai.amount - 560.086526927433) < 1e-9);
    assert.ok(Math.abs(dai.usd - dai.amount) < 1e-9);
    assert.ok(all.items.some((item) => item.token.symbol === "ETH" && item.usd > 0), "the network's own coin moves too");
    const big = await (await fetch(`${base}/market/chain/feed?min=1000`)).json();
    assert.ok(big.items.every((item) => item.usd >= 1000));
    const only = await (await fetch(`${base}/market/chain/feed?chain=optimism`)).json();
    assert.ok(only.items.every((item) => item.chain === "optimism"));
    assert.equal((await fetch(`${base}/market/chain/feed`, { method: "POST" })).status, 405);
  } finally { await new Promise((resolve) => service.server.close(resolve)); }
});

test("an address shows its holdings on every network, its transfers a page at a time, and its balance history", async () => {
  const { asked, get } = explorers();
  const chain = createChain({ get, now: () => Date.UTC(2026, 9, 25, 18, 15), nativePrice: (symbol) => (symbol === "BTC" ? 80_000 : null) });
  const holdings = await chain.holdings(EXCHANGE);
  assert.equal(holdings.kind, "evm");
  assert.deepEqual(holdings.networks.map((item) => item.chain), ["eth", "optimism"]);
  const symbols = holdings.assets.map((asset) => asset.token.symbol);
  assert.ok(symbols.includes("ETH") && symbols.includes("USDT"));
  assert.ok(!symbols.includes("Elon Musk DOGE"), "tokens without a price are left out");
  assert.ok(holdings.assets.every((asset, index) => index === 0 || holdings.assets[index - 1].usd >= asset.usd), "largest first");
  // A second look within three minutes is served from the copy.
  const before = asked.length;
  await chain.holdings(EXCHANGE.toLowerCase());
  assert.equal(asked.length, before);

  const page = await chain.transfers(EXCHANGE, "eth", "in", null);
  assert.ok(page.items.length > 0);
  assert.ok(asked.some((url) => url.includes("/token-transfers?type=ERC-20&filter=to")));
  assert.ok(asked.some((url) => url.includes("/transactions?filter=to")));
  assert.deepEqual(page.next.tokens, fixture("address-transfers.json").next_page_params);
  await chain.transfers(EXCHANGE, "eth", "in", page.next);
  assert.ok(asked.some((url) => url.includes("&filter=to&index=76&block_number=26271373")), "the next page follows the explorer's cursor");

  const history = await chain.history(EXCHANGE, "eth");
  assert.ok(history.length > 3 && history.every(([time, value], index) => index === 0 || history[index - 1][0] < time) && history[0][1] > 0);

  const coins = await chain.holdings(UTXO);
  assert.equal(coins.kind, "utxo");
  assert.ok(Math.abs(coins.assets[0].amount - 3.92755668) < 1e-9);
  assert.equal(coins.assets[0].usd, coins.assets[0].amount * 80_000);
  const moves = await chain.transfers(UTXO, "btc", "all", null);
  assert.ok(moves.items.length > 0 && moves.items.every((item) => item.from.address === UTXO || item.to.address === UTXO));

  assert.deepEqual(await chain.search(UTXO), [{ address: UTXO, name: null, kind: "utxo" }]);
  const found = await chain.search("vitalik.eth");
  assert.equal(found[0].name, "vitalik.eth");
  assert.deepEqual(await chain.search("ab"), []);
});

test("a slow network leaves the rest standing, and a busy minute serves copies instead of hammering the explorers", async () => {
  const { get } = explorers({ fail: ["explorer.optimism.io"] });
  let clock = Date.UTC(2026, 9, 25, 18, 15);
  const chain = createChain({ get, now: () => clock, perMinute: 2 });
  const holdings = await chain.holdings(EXCHANGE);
  assert.deepEqual(holdings.networks, [{ chain: "eth", ok: true, partial: false }, { chain: "optimism", ok: false, partial: false }]);
  await chain.feed();
  await assert.rejects(chain.transfers(EXCHANGE, "eth", "all", null), /busy/);
  clock += 61_000;
  assert.ok((await chain.transfers(EXCHANGE, "eth", "all", null)).items.length > 0);
});

test("signed-in visitors keep a private list of tracked and own addresses", async () => {
  const { createAccounts, readCookie } = await import("../blockchain/market-accounts.mjs");
  const NOW = 1_700_000_000_000;
  const ORIGIN = "https://markets.example";
  const state = {};
  const token = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
  const accounts = createAccounts({ file: ":memory:", clientId: "c", clientSecret: "s", publicUrl: ORIGIN, now: () => NOW,
    post: async () => ({ id_token: token({ iss: "https://accounts.google.com", aud: "c", exp: NOW / 1000 + 600, sub: state.sub,
      email: `${state.sub}@olympus.example`, email_verified: true, nonce: state.nonce }) }) });
  const service = createMarketService({ fetch: async () => { throw new Error("offline"); }, accounts });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const signIn = async (sub) => {
    state.sub = sub;
    const google = new URL((await fetch(`${base}/market/auth/google`, { redirect: "manual" })).headers.get("location"));
    state.nonce = google.searchParams.get("nonce");
    const back = await fetch(`${base}/market/auth/google/callback?code=c&state=${google.searchParams.get("state")}`, { redirect: "manual" });
    return readCookie(back.headers.get("set-cookie"), "__Host-nir_session");
  };
  const call = async (path, { cookie, method = "GET", body } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(cookie ? { cookie: `__Host-nir_session=${cookie}` } : {}),
      ...(method === "GET" ? {} : { origin: ORIGIN }), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    assert.equal((await call("/market/me/addresses")).status, 401);
    const zeus = await signIn("zeus");
    assert.equal((await call("/market/me/addresses/0x123", { cookie: zeus, method: "PUT", body: {} })).status, 400);
    assert.equal((await call(`/market/me/addresses/${EXCHANGE}`, { cookie: zeus, method: "PUT", body: { label: "x".repeat(41) } })).status, 400);
    await call(`/market/me/addresses/${EXCHANGE}`, { cookie: zeus, method: "PUT", body: { label: "  Olympus   hot wallet " } });
    const mine = await call(`/market/me/addresses/${UTXO}`, { cookie: zeus, method: "PUT", body: { mine: true } });
    assert.deepEqual(mine.data.addresses.map(({ address, label, mine: own }) => [address, label, own]),
      [[EXCHANGE.toLowerCase(), "Olympus hot wallet", false], [UTXO, "", true]]);
    // Saving the same wallet in another spelling updates it; the label stays unless a new one comes.
    const again = await call(`/market/me/addresses/${EXCHANGE.toLowerCase()}`, { cookie: zeus, method: "PUT", body: { mine: true } });
    assert.equal(again.data.addresses.length, 2);
    assert.deepEqual(again.data.addresses.find((item) => item.address === EXCHANGE.toLowerCase()), { address: EXCHANGE.toLowerCase(), label: "Olympus hot wallet", mine: true, addedAt: NOW });
    const athena = await signIn("athena");
    assert.deepEqual((await call("/market/me/addresses", { cookie: athena })).data.addresses, []);
    assert.equal((await call(`/market/me/addresses/${UTXO}`, { cookie: zeus, method: "DELETE" })).data.addresses.length, 1);
    await call("/market/me", { cookie: zeus, method: "DELETE" });
    const back = await signIn("zeus");
    assert.deepEqual((await call("/market/me/addresses", { cookie: back })).data.addresses, []);
  } finally { await new Promise((resolve) => service.server.close(resolve)); }
});
