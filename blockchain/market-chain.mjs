// NIR Markets on-chain explorer, in the manner of the analytics sites: a live
// feed of transfers across networks, any address's holdings, transfers and
// balance history, and search by address or name. Part of the market service
// (Caddy passes /market/* to it).
//
// Data comes from public, keyless sources: Blockscout explorers where they
// answer servers, free public nodes for the other account-based networks
// (market-rpc.mjs), and mempool.space for the UTXO network. Names are
// the explorers' open labels (name service records, verified contract names,
// community tags); there is no private entity database.
//
// Everything is fetched on demand and cached: the feed for 15 seconds, an
// address, its history and search for 10 minutes; an explorer that takes
// over 20 seconds to list an address's tokens is not waited for. A budget of fetches per
// minute keeps a burst of visitors from hammering the explorers; past it, a
// cached copy is served or the visitor is asked to retry.

import { createNodes, NODES, postRpc } from "./market-rpc.mjs";

const EXPLORERS = {
  eth: { api: "https://eth.blockscout.com/api/v2", native: "ETH" },
  optimism: { api: "https://explorer.optimism.io/api/v2", native: "ETH" },
};
const UTXO = { id: "btc", api: "https://mempool.space/api", native: "BTC" };
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UTXO_ADDRESS = /^(?:bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/;
const ICON = /^https:\/\/(?:coin-images\.coingecko\.com|assets\.coingecko\.com|raw\.githubusercontent\.com\/trustwallet)\//;
const MAX_BYTES = 8_000_000;

export async function fetchExplorer(url) {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "NIR-Markets/1.0" },
    signal: AbortSignal.timeout(45_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw Object.assign(new Error(`${new URL(url).host} answered ${response.status}`), { status: response.status });
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error("explorer response is too large");
  return JSON.parse(text);
}

export const addressKind = (value) => (EVM_ADDRESS.test(value) ? "evm" : UTXO_ADDRESS.test(value) ? "utxo" : null);
const number = (value) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
const label = (text, max = 60) => (typeof text === "string" && text.trim() ? text.trim().slice(0, max) : null);
// A whole number of base units as a decimal amount ("1500000", 6 → 1.5).
export function units(value, decimals) {
  const digits = Number(decimals);
  if (typeof value !== "string" || !/^\d{1,80}$/.test(value) || !Number.isInteger(digits) || digits < 0 || digits > 36) return null;
  const padded = value.padStart(digits + 1, "0");
  return Number(`${padded.slice(0, padded.length - digits)}.${padded.slice(padded.length - digits) || "0"}`);
}

// One side of a transfer: the address and the best open name for it.
export function party(value) {
  if (!value?.hash || !EVM_ADDRESS.test(value.hash)) return null;
  const tags = Array.isArray(value.metadata?.tags) ? value.metadata.tags : [];
  const named = tags.find((tag) => tag?.tagType === "name");
  const kinds = tags.filter((tag) => tag?.tagType === "generic" || tag?.tagType === "protocol").map((tag) => label(tag.name, 30)).filter(Boolean);
  return {
    address: value.hash,
    name: label(value.ens_domain_name) ?? label(named?.name) ?? label(value.public_tags?.[0]?.display_name ?? value.public_tags?.[0]?.label) ?? label(value.name),
    tags: [...new Set(kinds)].slice(0, 4),
    contract: Boolean(value.is_contract),
  };
}
function token(value) {
  return {
    address: EVM_ADDRESS.test(value?.address_hash ?? "") ? value.address_hash : null,
    symbol: label(value?.symbol, 20) ?? "?", name: label(value?.name) ?? "",
    icon: ICON.test(value?.icon_url ?? "") ? value.icon_url : null, price: number(value?.exchange_rate),
  };
}

// A token transfer from an explorer, with its dollar value when the token has a price.
export function normalizeTransfer(chain, item) {
  if (!item || item.token_type !== "ERC-20" || item.token?.reputation === "scam") return null;
  const from = party(item.from);
  const to = party(item.to);
  const amount = units(item.total?.value, item.total?.decimals ?? item.token?.decimals);
  if (!from || !to || amount === null || typeof item.transaction_hash !== "string") return null;
  const coin = token(item.token);
  return { id: `${chain}:${item.transaction_hash}:${item.log_index ?? 0}`, chain, hash: item.transaction_hash,
    time: Date.parse(item.timestamp) || null, from, to, token: coin, amount, usd: coin.price === null ? null : amount * coin.price };
}
// A plain transfer of the network's own coin.
export function normalizeTransaction(chain, item, native) {
  const from = party(item?.from);
  const to = party(item?.to);
  const amount = units(item?.value, 18);
  if (!from || !to || !amount || item.status !== "ok") return null;
  const price = number(item.exchange_rate);
  return { id: `${chain}:${item.hash}:native`, chain, hash: item.hash, time: Date.parse(item.timestamp) || null, from, to,
    token: { address: null, symbol: native, name: native, icon: null, price }, amount, usd: price === null ? null : amount * price };
}

export function createChain({ get = fetchExplorer, rpc = postRpc, now = Date.now, perMinute = 60, nativePrice = () => null, tokenWait = 20_000,
  labelFor = () => null } = {}) {
  const cache = new Map();
  const pending = new Map();
  let used = [];
  // Cached fetch: a fresh copy within ttl; past the budget a stale copy, or an error the page can show.
  // `stale`: an expired copy is answered at once while a fresh one is fetched behind it.
  async function cached(key, ttl, load, { stale = false } = {}) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value;
    if (hit && stale) {
      if (!pending.has(key)) void cached(key, ttl, load).catch(() => {});
      return hit.value;
    }
    if (pending.has(key)) return pending.get(key);
    used = used.filter((at) => now() - at < 60_000);
    if (used.length >= perMinute) {
      if (hit) return hit.value;
      throw Object.assign(new Error("busy, try again in a minute"), { status: 503 });
    }
    used.push(now());
    const job = (async () => {
      try {
        const value = await load();
        cache.set(key, { at: now(), value });
        if (cache.size > 800) cache.delete(cache.keys().next().value);
        return value;
      } catch (error) {
        if (hit) return hit.value;
        throw error;
      }
    })();
    pending.set(key, job);
    try { return await job; } finally { pending.delete(key); }
  }

  const nodes = createNodes({ rpc, get, cached });

  // --- The feed: the latest token and coin transfers on every network, newest first.
  const seen = new Map();
  async function feed() {
    return cached("feed", 15_000, async () => {
      const lists = await Promise.all(Object.entries(EXPLORERS).flatMap(([chain, explorer]) => [
        get(`${explorer.api}/token-transfers?type=ERC-20`).then((data) => (data?.items ?? []).map((item) => normalizeTransfer(chain, item))).catch(() => []),
        get(`${explorer.api}/transactions?filter=validated`).then((data) => (data?.items ?? []).map((item) => normalizeTransaction(chain, item, explorer.native))).catch(() => []),
      ]).concat(nodes.feed().catch(() => [])));
      for (const item of lists.flat()) if (item && item.time) seen.set(item.id, item);
      // The newest 400 are kept, so the feed grows while people watch.
      const kept = [...seen.values()].sort((left, right) => right.time - left.time).slice(0, 400);
      seen.clear();
      for (const item of kept) seen.set(item.id, item);
      return kept;
    }, { stale: true });
  }

  // --- An address: what it holds on every network, with names and tags.
  async function evmHoldings(address) {
    const chains = await Promise.all(Object.entries(EXPLORERS).map(async ([chain, explorer]) => {
      try {
        // Addresses holding thousands of tokens can take the explorer minutes; the coin balance still shows.
        const [info, balances] = await Promise.all([get(`${explorer.api}/addresses/${address}`),
          Promise.race([get(`${explorer.api}/addresses/${address}/token-balances`),
            new Promise((resolve) => { setTimeout(resolve, tokenWait, undefined).unref?.(); })]).catch(() => undefined)]);
        const price = number(info?.exchange_rate);
        const native = units(info?.coin_balance ?? "0", 18) ?? 0;
        const assets = native > 0 ? [{ chain, token: { address: null, symbol: explorer.native, name: explorer.native, icon: null, price },
          amount: native, usd: price === null ? null : native * price }] : [];
        for (const item of Array.isArray(balances) ? balances : []) {
          if (item?.token?.type !== "ERC-20" || item.token.reputation === "scam") continue;
          const coin = token(item.token);
          const amount = units(item.value, item.token.decimals);
          if (!amount || coin.price === null || amount * coin.price < 0.01) continue;
          assets.push({ chain, token: coin, amount, usd: amount * coin.price });
        }
        return { chain, ok: true, partial: balances === undefined, info: info ? party({ ...info, hash: address }) : null, assets: assets.sort((left, right) => (right.usd ?? 0) - (left.usd ?? 0)).slice(0, 100) };
      } catch {
        return { chain, ok: false, info: null, assets: [] };
      }
    }));
    // The other networks, read from public nodes in one call each.
    chains.push(...await nodes.holdings(address).catch(() => Object.keys(NODES).map((chain) => ({ chain, ok: false, partial: false, info: null, assets: [] }))));
    const named = chains.map((item) => item.info).find((info) => info?.name) ?? chains.find((item) => item.info)?.info;
    return { address, kind: "evm", name: named?.name ?? null, tags: [...new Set(chains.flatMap((item) => item.info?.tags ?? []))],
      contract: chains.some((item) => item.info?.contract), networks: chains.map(({ chain, ok, partial }) => ({ chain, ok, partial: Boolean(partial) })),
      assets: chains.flatMap((item) => item.assets).sort((left, right) => (right.usd ?? 0) - (left.usd ?? 0)) };
  }
  async function utxoHoldings(address) {
    const data = await get(`${UTXO.api}/address/${address}`);
    const stats = (key) => (data?.chain_stats?.[key] ?? 0) + (data?.mempool_stats?.[key] ?? 0);
    const amount = (stats("funded_txo_sum") - stats("spent_txo_sum")) / 1e8;
    const price = nativePrice(UTXO.native);
    return { address, kind: "utxo", name: null, tags: [], contract: false, networks: [{ chain: UTXO.id, ok: Boolean(data) }],
      transactions: stats("tx_count"),
      assets: amount > 0 ? [{ chain: UTXO.id, token: { address: null, symbol: UTXO.native, name: UTXO.native, icon: null, price },
        amount, usd: price === null ? null : amount * price }] : [] };
  }
  const holdings = (address) => cached(`holdings:${address.toLowerCase()}`, 600_000,
    () => (addressKind(address) === "evm" ? evmHoldings(address) : utxoHoldings(address)));

  // --- An address's transfers on one network, in or out, a page at a time.
  async function evmTransfers(address, chain, direction, cursor) {
    const explorer = EXPLORERS[chain];
    const filter = direction === "in" ? "&filter=to" : direction === "out" ? "&filter=from" : "";
    const query = (next) => (next ? `&${new URLSearchParams(Object.entries(next).map(([key, value]) => [key, String(value)]))}` : "");
    const [tokens, coins] = await Promise.all([
      cursor?.tokens === null ? null : get(`${explorer.api}/addresses/${address}/token-transfers?type=ERC-20${filter}${query(cursor?.tokens)}`),
      cursor?.coins === null ? null : get(`${explorer.api}/addresses/${address}/transactions?${filter.slice(1)}${query(cursor?.coins)}`),
    ]);
    const items = [...(tokens?.items ?? []).map((item) => normalizeTransfer(chain, item)),
      ...(coins?.items ?? []).map((item) => normalizeTransaction(chain, item, explorer.native))].filter(Boolean);
    const next = { tokens: tokens?.next_page_params ?? null, coins: coins?.next_page_params ?? null };
    return { items: items.sort((left, right) => right.time - left.time), next: next.tokens || next.coins ? next : null };
  }
  async function utxoTransfers(address, direction, cursor) {
    const list = await get(`${UTXO.api}/address/${address}/txs${cursor?.after ? `/chain/${cursor.after}` : ""}`);
    const price = nativePrice(UTXO.native);
    const items = (Array.isArray(list) ? list : []).map((tx) => {
      const spent = (tx.vin ?? []).filter((input) => input.prevout?.scriptpubkey_address === address).reduce((sum, input) => sum + (input.prevout.value ?? 0), 0);
      const received = (tx.vout ?? []).filter((output) => output.scriptpubkey_address === address).reduce((sum, output) => sum + (output.value ?? 0), 0);
      const net = (received - spent) / 1e8;
      const others = net >= 0 ? (tx.vin ?? []).map((input) => input.prevout?.scriptpubkey_address) : (tx.vout ?? []).map((output) => output.scriptpubkey_address);
      const other = others.find((value) => value && value !== address) ?? null;
      const self = { address, name: null, tags: [], contract: false };
      const counterpart = { address: other, name: null, tags: [], contract: false };
      return { id: `btc:${tx.txid}`, chain: UTXO.id, hash: tx.txid, time: tx.status?.block_time ? tx.status.block_time * 1000 : now(),
        from: net >= 0 ? counterpart : self, to: net >= 0 ? self : counterpart,
        token: { address: null, symbol: UTXO.native, name: UTXO.native, icon: null, price }, amount: Math.abs(net), usd: price === null ? null : Math.abs(net) * price };
    }).filter((item) => item.amount > 0 && (direction === "all" || (direction === "in") === (item.to.address === address)));
    const last = Array.isArray(list) && list.length >= 25 ? list.at(-1).txid : null;
    return { items, next: last ? { after: last } : null };
  }
  function transfers(address, chain, direction, cursor) {
    const key = `transfers:${address.toLowerCase()}:${chain}:${direction}:${JSON.stringify(cursor ?? null)}`;
    return cached(key, 60_000, async () => (addressKind(address) === "utxo" ? utxoTransfers(address, direction, cursor)
      : NODES[chain] ? nodes.addressTransfers(address, chain, direction, cursor?.before ?? null) : evmTransfers(address, chain, direction, cursor)));
  }

  // --- The network coin's balance by day, from the explorer.
  function history(address, chain) {
    return cached(`history:${address.toLowerCase()}:${chain}`, 600_000, async () => {
      const data = await get(`${EXPLORERS[chain].api}/addresses/${address}/coin-balance-history-by-day`);
      return (data?.items ?? []).map((item) => [Date.parse(item.date), units(item.value, 18)]).filter(([time, value]) => time && value !== null)
        .sort((left, right) => left[0] - right[0]);
    });
  }

  // --- Search: an address as it is, or a name from the name service and the explorers' labels.
  function search(query) {
    const text = query.trim();
    if (addressKind(text)) return Promise.resolve([{ address: text, name: null, kind: addressKind(text) }]);
    if (text.length < 3 || text.length > 60) return Promise.resolve([]);
    return cached(`search:${text.toLowerCase()}`, 600_000, async () => {
      const data = await get(`${EXPLORERS.eth.api}/search?q=${encodeURIComponent(text)}`);
      return (data?.items ?? []).filter((item) => (item.type === "ens_domain" || item.type === "address" || item.type === "label") && EVM_ADDRESS.test(item.address_hash ?? item.address ?? ""))
        .map((item) => ({ address: item.address_hash ?? item.address, name: label(item.ens_info?.name ?? item.name), kind: "evm" })).slice(0, 8);
    });
  }

  // Each asset gets the id of its coin page here, by contract address or, for a network coin, by symbol.
  async function withCoinIds(data) {
    const ids = await nodes.coinIds().catch(() => null);
    if (!ids) return data;
    return { ...data, assets: data.assets.map((asset) => ({ ...asset, token: { ...asset.token,
      coinId: asset.token.address ? ids.contract.get(asset.token.address.toLowerCase()) ?? null : ids.symbol.get(asset.token.symbol) ?? null } })) };
  }
  // The feed is refreshed in the background, so a visitor never waits for the explorers.
  function warm(every = 15_000) {
    const tick = () => { void feed().catch(() => {}); };
    tick();
    const timer = setInterval(tick, every);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // Names approved by NIR Markets moderators (market-labels.mjs) go ahead of the explorers' labels.
  const named = (party) => {
    const name = party?.address ? labelFor(party.address) : null;
    return name ? { ...party, name, tags: ["NIR Markets", ...(party.tags ?? []).filter((tag) => tag !== "NIR Markets")] } : party;
  };
  const relabel = (items) => items.map((item) => ({ ...item, from: named(item.from), to: named(item.to) }));
  const reply = (response, status, body, maxAge = 15) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=${maxAge}` : "no-store" });
    response.end(JSON.stringify(body));
  };
  // Answers GET /market/chain/..., or returns false.
  async function handle(request, response, url) {
    const path = url.pathname;
    if (!path.startsWith("/market/chain/")) return false;
    if (request.method !== "GET") return reply(response, 405, { error: "read only" }), true;
    try {
      if (path === "/market/chain/feed") {
        const min = Math.max(0, Number(url.searchParams.get("min")) || 0);
        const chain = url.searchParams.get("chain");
        const items = relabel((await feed()).filter((item) => (item.usd ?? 0) >= min && (!chain || item.chain === chain)).slice(0, 200));
        return reply(response, 200, { networks: [...Object.keys(EXPLORERS), ...Object.keys(NODES)], items }, 10), true;
      }
      if (path === "/market/chain/search") {
        const results = (await search(url.searchParams.get("q") ?? "")).map((item) => ({ ...item, name: labelFor(item.address) ?? item.name }));
        return reply(response, 200, { results }, 300), true;
      }
      const match = /^\/market\/chain\/address\/([^/]+)(?:\/(transfers|history))?$/.exec(path);
      if (!match || !addressKind(match[1])) return reply(response, 404, { error: "not an address" }), true;
      const [, address, part] = match;
      if (!part) {
        const data = await withCoinIds(await holdings(address));
        const own = labelFor(address);
        // A short browser cache: the server keeps its own copy, and a newly approved name shows at once.
        return reply(response, 200, own ? { ...data, name: own, tags: ["NIR Markets", ...data.tags] } : data, 5), true;
      }
      const chain = addressKind(address) === "utxo" ? UTXO.id : url.searchParams.get("chain") ?? "eth";
      if (chain !== UTXO.id && !EXPLORERS[chain] && !NODES[chain]) return reply(response, 404, { error: "unknown network" }), true;
      if (part === "history") {
        // Balance history needs an explorer; the node networks have none.
        if (!EXPLORERS[chain]) return reply(response, 200, { chain, points: [] }, 600), true;
        return reply(response, 200, { chain, symbol: EXPLORERS[chain].native, points: await history(address, chain) }, 600), true;
      }
      const direction = ["in", "out"].includes(url.searchParams.get("dir")) ? url.searchParams.get("dir") : "all";
      let cursor = null;
      try { cursor = url.searchParams.get("cursor") ? JSON.parse(Buffer.from(url.searchParams.get("cursor"), "base64url").toString("utf8")) : null; } catch {}
      if (cursor !== null && (typeof cursor !== "object" || JSON.stringify(cursor).length > 600)) cursor = null;
      const page = await transfers(address, chain, direction, cursor);
      return reply(response, 200, { chain, items: relabel(page.items), next: page.next ? Buffer.from(JSON.stringify(page.next)).toString("base64url") : null,
        ...(page.reached ? { reached: page.reached } : {}) }, 30), true;
    } catch (error) {
      return reply(response, error?.status === 503 ? 503 : 502, { error: "the explorer is unavailable, try again in a minute" }), true;
    }
  }

  return { handle, feed, holdings, transfers, history, search, warm, networks: [...Object.keys(EXPLORERS), ...Object.keys(NODES), UTXO.id] };
}
