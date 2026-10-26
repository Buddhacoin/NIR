import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { addressKind, createChain, party, units } from "../blockchain/market-chain.mjs";
import { decodeAggregate3, encodeAggregate3 } from "../blockchain/market-rpc.mjs";
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
    if (url.includes("/coins/list?include_platform=true")) return fixture("coin-list.json");
    if (url.includes("api.coingecko.com/api/v3/coins/markets")) return fixture("coin-markets.json");
    if (url.includes("mempool.space/api/address/") && url.endsWith("/txs")) return fixture("utxo-txs.json");
    if (url.includes("mempool.space/api/address/")) return fixture("utxo-address.json");
    if (url.includes("/search/quick?q=")) return fixture("search-quick.json");
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
  return { asked, get, rpc: node().rpc };
}

// A public node: Multicall3 answers (decimals, balances), the newest block, and token transfer logs.
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
function results(list) {
  // ABI-encodes (bool success, bytes data)[] the way Multicall3 answers.
  const tails = list.map(({ success, data }) => { const body = data.replace(/^0x/, ""); return word(success ? 1 : 0) + word(64) + word(body.length / 2) + body.padEnd(Math.ceil(body.length / 64) * 64, "0"); });
  let offset = list.length * 32;
  const heads = tails.map((tail) => { const head = word(offset); offset += tail.length / 2; return head; });
  return `0x${word(32)}${word(list.length)}${heads.join("")}${tails.join("")}`;
}
function node() {
  const calls = [];
  const rpc = async (url, method, params) => {
    calls.push({ url, method, params });
    if (method === "eth_getBlockByNumber") return { number: "0x100000", timestamp: "0x6700000" };
    if (method === "eth_getTransactionCount") return url.includes("base") ? "0x3" : "0x0";
    if (method === "eth_getLogs") {
      const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
      // The transfer sits in the newest window only.
      if (!url.includes("base") || !params[0].address.includes(usdc) || params[0].toBlock !== "0x100000") return [];
      return [{ address: usdc, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", `0x${word(`0x${EXCHANGE.slice(2)}`)}`, `0x${word("0x1234")}`],
        data: `0x${word(2_500_000_000)}`, blockNumber: "0xfffff0", transactionHash: `0x${"ab".repeat(32)}`, logIndex: "0x3" }];
    }
    // eth_call to Multicall3: decimals, or [the coin balance, then each token's balance].
    const data = params[0].data;
    const decoded = data.slice(10);
    const count = Number(BigInt(`0x${decoded.slice(64, 128)}`));
    const selectors = [];
    for (let index = 0; index < count; index += 1) {
      const at = 128 + Number(BigInt(`0x${decoded.slice(128 + index * 64, 192 + index * 64)}`)) * 2;
      selectors.push(decoded.slice(at + 64 * 4, at + 64 * 4 + 8));
    }
    return results(selectors.map((selector, index) => {
      if (selector === "313ce567") return { success: true, data: `0x${word(6)}` };
      if (selector === "4d2301cc") return { success: true, data: `0x${word(10n ** 18n / 2n)}` }; // half a coin
      if (selector === "70a08231") return { success: true, data: `0x${word(index === 1 ? 125_000_000 : 0)}` }; // 125 of the first token
      return { success: false, data: "0x" };
    }));
  };
  return { calls, rpc };
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
  const { get, rpc } = explorers();
  const chain = createChain({ get, rpc, now: () => Date.UTC(2026, 9, 25, 18, 15) });
  const service = createMarketService({ fetch: async () => { throw new Error("offline"); }, chain });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const all = await (await fetch(`${base}/market/chain/feed`)).json();
    assert.deepEqual(all.networks, ["eth", "optimism", "base", "arbitrum", "polygon", "bsc"]);
    const fromNode = all.items.find((item) => item.chain === "base");
    assert.deepEqual([fromNode.token.symbol, fromNode.amount, fromNode.usd, fromNode.from.address], ["USDC", 2500, 2500, EXCHANGE.toLowerCase()]);
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
  const { asked, get, rpc } = explorers();
  const chain = createChain({ get, rpc, now: () => Date.UTC(2026, 9, 25, 18, 15), nativePrice: (symbol) => (symbol === "BTC" ? 80_000 : null) });
  const holdings = await chain.holdings(EXCHANGE);
  assert.equal(holdings.kind, "evm");
  assert.deepEqual(holdings.networks.map((item) => item.chain), ["eth", "optimism", "base", "arbitrum", "polygon", "bsc"]);
  // The node networks: the coin and the listed tokens with a balance, priced; unpriced tokens never listed.
  assert.deepEqual(holdings.networks.find((item) => item.chain === "base"), { chain: "base", ok: true, partial: false, active: true, sent: 3 },
    "a node network counts the address's own transactions");
  const base = holdings.assets.filter((asset) => asset.chain === "base");
  assert.deepEqual(base.map((asset) => [asset.token.symbol, asset.amount, asset.usd]).sort(), [["ETH", 0.5, 1175], ["USDC", 125, 125]]);
  const polygon = holdings.assets.filter((asset) => asset.chain === "polygon").map((asset) => asset.token.symbol);
  assert.equal(polygon.filter((symbol) => symbol === "POL").length, 1, "the coin's own token contract is not counted twice");
  assert.ok(holdings.assets.some((asset) => asset.chain === "bsc" && asset.token.symbol === "BNB" && asset.usd === 370));
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

  const onNode = await chain.transfers(EXCHANGE, "base", "out", null);
  assert.equal(onNode.items.length, 1);
  // Windows of 600, 2,400, 9,600, 38,400 and then 49,000 blocks: eight in all.
  assert.equal(onNode.next.before, 0x100000 - (601 + 2_401 + 9_601 + 38_401 + 4 * 49_001), "a node page reads eight widening windows back, then hands the next block");
  const older = await chain.transfers(EXCHANGE, "base", "out", onNode.next);
  assert.equal(older.items.length, 0);

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
  assert.ok(found.some((item) => item.name === "vitalik.eth"));
  // Wallets by name, as the analytics sites find entities: people's wallets first, then contracts.
  const entity = await chain.search("olympus");
  assert.deepEqual(entity.slice(0, 2).map((item) => [item.name, item.entity, item.contract]),
    [["Olympus: Digital Asset Fund", "Olympus", false], ["vitalik.eth", null, false]]);
  assert.deepEqual(entity.at(-1).address, "0x7712c34205737192402172409a8F7ccef8aA2AEc");
  assert.deepEqual(await chain.search("ab"), []);
});

test("a slow network leaves the rest standing, and a busy minute serves copies instead of hammering the explorers", async () => {
  const { get } = explorers({ fail: ["explorer.optimism.io"] });
  let clock = Date.UTC(2026, 9, 25, 18, 15);
  const down = async () => { throw new Error("node down"); };
  const chain = createChain({ get, rpc: down, now: () => clock, perMinute: 4 });
  const holdings = await chain.holdings(EXCHANGE);
  assert.deepEqual(holdings.networks, [{ chain: "eth", ok: true, partial: false, active: true }, { chain: "optimism", ok: false, partial: false, active: false },
    ...["base", "arbitrum", "polygon", "bsc"].map((name) => ({ chain: name, ok: false, partial: false, active: false }))]);
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

test("Multicall3 calls are ABI-encoded and its answers decoded", () => {
  const encoded = encodeAggregate3([{ target: EXCHANGE, data: "0x313ce567" }, { target: EXCHANGE, data: `0x70a08231${"0".repeat(24)}${EXCHANGE.slice(2).toLowerCase()}` }]);
  assert.ok(encoded.startsWith("0x82ad56cb"));
  assert.equal((encoded.length - 10) % 64, 0, "whole 32-byte words");
  assert.deepEqual(decodeAggregate3(results([{ success: true, data: `0x${word(18)}` }, { success: false, data: "0x" }])),
    [{ success: true, data: `0x${word(18)}` }, { success: false, data: "0x" }]);
});

test("visitors suggest wallet names, moderators approve them, and approved names lead everywhere", async () => {
  const { createAccounts, readCookie } = await import("../blockchain/market-accounts.mjs");
  const NOW = 1_700_000_000_000;
  const ORIGIN = "https://markets.example";
  const state = {};
  const token = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
  const accounts = createAccounts({ file: ":memory:", clientId: "c", clientSecret: "s", publicUrl: ORIGIN, now: () => NOW, admins: ["athena@olympus.example"],
    post: async () => ({ id_token: token({ iss: "https://accounts.google.com", aud: "c", exp: NOW / 1000 + 600, sub: state.sub,
      email: `${state.sub}@olympus.example`, email_verified: true, nonce: state.nonce }) }) });
  const { get, rpc } = explorers();
  const chain = createChain({ get, rpc, now: () => NOW, labelFor: accounts.labelFor });
  const service = createMarketService({ fetch: async () => { throw new Error("offline"); }, accounts, chain });
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
    assert.equal((await call("/market/labels", { method: "POST", body: { address: EXCHANGE, name: "Olympus" } })).status, 401);
    const zeus = await signIn("zeus");
    for (const bad of [{ address: "0x1", name: "Olympus" }, { address: EXCHANGE, name: "O" }, { address: EXCHANGE, name: "x".repeat(41) },
      { address: EXCHANGE, name: "Olympus", link: "javascript:alert(1)" }]) {
      assert.equal((await call("/market/labels", { cookie: zeus, method: "POST", body: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await call("/market/labels", { cookie: zeus, method: "POST", body: { address: EXCHANGE, name: "Olympus  exchange", link: "https://olympus.example/reserves" } })).status, 201);
    assert.equal((await call("/market/me", { cookie: zeus })).data.moderator, false);
    assert.equal((await call("/market/labels/pending", { cookie: zeus })).status, 403, "only moderators see the queue");
    // Nothing changes until a moderator decides.
    assert.notEqual((await call(`/market/chain/address/${EXCHANGE}`)).data.name, "Olympus exchange");

    const athena = await signIn("athena");
    assert.equal((await call("/market/me", { cookie: athena })).data.moderator, true);
    const pending = await call("/market/labels/pending", { cookie: athena });
    assert.equal(pending.status, 200, JSON.stringify(pending.data));
    const queue = pending.data.suggestions;
    assert.deepEqual(queue.map(({ address, name, link }) => [address, name, link]), [[EXCHANGE.toLowerCase(), "Olympus exchange", "https://olympus.example/reserves"]]);
    assert.equal((await call(`/market/labels/${queue[0].id}/approve`, { cookie: zeus, method: "POST" })).status, 403);
    assert.deepEqual((await call(`/market/labels/${queue[0].id}/approve`, { cookie: athena, method: "POST" })).data.suggestions, []);

    const wallet = (await call(`/market/chain/address/${EXCHANGE.toLowerCase()}`)).data;
    assert.equal(wallet.name, "Olympus exchange");
    assert.equal(wallet.tags[0], "NIR Markets");
    // Assets link to coin pages: by contract, and the network coins by symbol.
    assert.equal(wallet.assets.find((asset) => asset.chain === "base" && asset.token.symbol === "USDC").token.coinId, "usd-coin");
    assert.equal(wallet.assets.find((asset) => asset.chain === "bsc" && asset.token.symbol === "BNB").token.coinId, "binancecoin");
    const feed = (await call("/market/chain/feed")).data.items;
    assert.ok(feed.some((item) => item.from.address.toLowerCase() === EXCHANGE.toLowerCase() && item.from.name === "Olympus exchange"));
    assert.equal(accounts.labelFor(EXCHANGE.toUpperCase().replace("0X", "0x")), "Olympus exchange");
  } finally { await new Promise((resolve) => service.server.close(resolve)); }
});

test("the feed answers at once from its last copy while a fresh one is fetched behind it", async () => {
  const { get, rpc } = explorers();
  let clock = Date.UTC(2026, 9, 25, 18, 15);
  let fetched = 0;
  const counting = async (url) => { if (url.includes("/token-transfers?type=ERC-20")) fetched += 1; return get(url); };
  const chain = createChain({ get: counting, rpc, now: () => clock });
  const first = await chain.feed();
  assert.equal(fetched, 2, "both explorers asked once");
  clock += 60_000;
  const again = await chain.feed();
  assert.equal(again, first, "the old copy comes back without waiting");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fetched, 4, "and a refresh ran behind it");
  const stop = chain.warm(1_000_000);
  stop();
});

test("open labels give known wallets a name and a picture, asked fifty at a time and kept a day", async () => {
  const { createNames, readTags } = await import("../blockchain/market-names.mjs");
  const oli = "https://blockscout-icons.s3.us-east-1.amazonaws.com/OLI_tag_logo.svg";
  const tags = [
    { slug: "olympus-hot", name: "Olympus: Hot Wallet", tagType: "name", ordinal: 10, meta: JSON.stringify({ main_entity: "Olympus", "tagIcon ": oli, tooltipUrl: "https://www.olympus.example/en" }) },
    { slug: "exchange", name: "Exchange", tagType: "generic", ordinal: 0, meta: "{}" },
    { slug: "olympus-4", name: "Olympus 4", tagType: "name", ordinal: 0, meta: "{}" },
  ];
  assert.deepEqual(readTags(tags), { name: "Olympus: Hot Wallet", entity: "Olympus", site: "https://www.olympus.example",
    logo: "https://www.google.com/s2/favicons?sz=64&domain=www.olympus.example" }, "the site's icon stands in for the labels' own badge");
  assert.equal(readTags([{ name: "Delos", tagType: "name", meta: JSON.stringify({ appLogoURL: "https://cdn.example/delos.png" }) }]).logo, "https://cdn.example/delos.png");
  assert.equal(readTags([{ name: "x", tagType: "generic" }]), null);

  let clock = 0;
  const asked = [];
  const zeus = `0x${"a".repeat(40)}`;
  const names = createNames({ now: () => clock, get: async (url) => {
    asked.push(url);
    return { addresses: { [zeus.toUpperCase().replace("0X", "0x")]: { tags } } };
  } });
  const many = Array.from({ length: 120 }, (_, index) => `0x${index.toString(16).padStart(40, "0")}`);
  await names.lookup([zeus, ...many, "bc1notevm"]);
  assert.equal(asked.length, 3, "121 addresses: three requests");
  assert.equal(names.name(zeus).name, "Olympus: Hot Wallet");
  assert.equal(names.name(many[0]), null);
  await names.lookup([zeus]);
  assert.equal(asked.length, 3, "known for a day");
  clock += 86_400_001;
  await names.lookup([zeus]);
  assert.equal(asked.length, 4);
});

test("the popular wallets directory pages through a group's open labels, fifty at a time", async () => {
  const { createNames } = await import("../blockchain/market-names.mjs");
  const zeus = `0x${"1".repeat(40)}`;
  const hera = `0x${"2".repeat(40)}`;
  const asked = [];
  const names = createNames({ get: async (url) => {
    asked.push(url);
    if (url.includes("/addresses?")) return url.includes("page_token") ? { items: [hera], next_page_params: null }
      : { items: [zeus, "not-an-address"], next_page_params: { page_token: hera, page_size: 50 } };
    return { addresses: { [zeus]: { tags: [{ name: "Olympus Exchange: Hot Wallet", tagType: "name", meta: JSON.stringify({ tooltipUrl: "https://olympus.example" }) }] } } };
  } });
  const first = await names.directory("exchange");
  assert.deepEqual(first.items.map((item) => [item.address, item.name]), [[zeus, "Olympus Exchange: Hot Wallet"]]);
  assert.equal(first.items[0].logo, "https://www.google.com/s2/favicons?sz=64&domain=olympus.example");
  assert.equal(first.next, hera);
  assert.match(asked[0], /slug=exchange&tagType=generic&chain_id=1&page_size=50$/);
  const second = await names.directory("exchange", first.next);
  assert.deepEqual(second, { items: [{ address: hera, name: null, entity: null, site: null, logo: null }], next: null });
  assert.equal(await names.directory("everyone"), null);
  const count = asked.length;
  await names.directory("exchange");
  assert.equal(asked.length, count, "a page is kept");
});
