// NIR Markets on-chain explorer, in the manner of the analytics sites: a live
// feed of transfers across networks, any address's holdings, transfers and
// balance history, and search by address or name. Part of the market service
// (Caddy passes /market/* to it).
//
// Data comes from public, keyless sources: Blockscout explorers where they
// answer servers, free public nodes for the other account-based networks
// (market-rpc.mjs), and mempool.space for the UTXO network. Names are
// the explorers' open labels (name service records, verified contract names,
// community tags), kept in NIR Markets' own book with guesses from wallets' behaviour (market-names.mjs,
// market-behaviour.mjs); an organisation's addresses stay on the server, its pages show it as one wallet.
//
// Everything is fetched on demand and cached: the feed for 15 seconds, an
// address, its history and search for 10 minutes; an explorer that takes
// over 20 seconds to list an address's tokens is not waited for. A budget of fetches per
// minute keeps a burst of visitors from hammering the explorers; past it, a
// cached copy is served or the visitor is asked to retry.

import { readFileSync, writeFileSync } from "node:fs";
import { MASKED, short } from "./market-masks.mjs";
import { createNames } from "./market-names.mjs";
import { BACKUP, createNodes, NODES, postRpc } from "./market-rpc.mjs";

const EXPLORERS = {
  eth: { api: "https://eth.blockscout.com/api/v2", native: "ETH" },
  optimism: { api: "https://explorer.optimism.io/api/v2", native: "ETH" },
};
const UTXO = { id: "btc", api: "https://mempool.space/api", native: "BTC" };
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UTXO_ADDRESS = /^(?:bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/;
const ICON = /^https:\/\/(?:coin-images\.coingecko\.com|assets\.coingecko\.com|raw\.githubusercontent\.com\/trustwallet)\//;
const MAX_BYTES = 8_000_000;

export async function fetchExplorer(url, headers = {}) {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "NIR-Markets/1.0", ...headers },
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
  labelFor = () => null, namesFile = ":memory:", names = createNames({ get, now, file: namesFile }), logos = null, opensea = null, ledger = null, patoshi = null, masks = null,
  crawlGap = 400, crawlPages = 400 } = {}) {
  const cache = new Map();
  const pending = new Map();
  let used = [];
  // Cached fetch: a fresh copy within ttl; past the budget a stale copy, or an error the page can show.
  // `stale`: an expired copy is answered at once while a fresh one is fetched behind it.
  // `nodes`: work on the public nodes, which has a budget of its own (the nodes keep their own pace,
  // one request at a time, so a flood of new wallets must not queue up behind each other).
  let nodeUsed = [];
  const failedUntil = new Map(); // key → time before which a lookup that failed without a copy is not tried again
  // `background`: work no visitor waits for (the lists' sums, organisations' wallets) takes at most 60 % of
  // the budget, so a visitor's page always has room.
  async function cached(key, ttl, load, { stale = false, nodes: onNodes = false, background = false } = {}) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value;
    if (!hit && (failedUntil.get(key) ?? 0) > now()) throw Object.assign(new Error("busy, try again in a minute"), { status: 503 });
    if (hit && stale) {
      if (!pending.has(key)) void cached(key, ttl, load, { nodes: onNodes }).catch(() => {});
      return hit.value;
    }
    if (pending.has(key)) return pending.get(key);
    used = used.filter((at) => now() - at < 60_000);
    nodeUsed = nodeUsed.filter((at) => now() - at < 60_000);
    const spent = onNodes ? nodeUsed : used;
    if (spent.length >= (onNodes ? 30 : background ? Math.floor(perMinute * 0.6) : perMinute)) {
      if (hit) return hit.value;
      throw Object.assign(new Error("busy, try again in a minute"), { status: 503 });
    }
    spent.push(now());
    const job = (async () => {
      try {
        const value = await load();
        // Most recently used last: the cache drops the longest unused entry, never a busy one.
        cache.delete(key);
        cache.set(key, { at: now(), value });
        if (cache.size > 800) cache.delete(cache.keys().next().value);
        return value;
      } catch (error) {
        // A failed refresh keeps the old copy and tries again in a minute, not on every request.
        if (hit) { hit.at = now() - ttl + 60_000; return hit.value; }
        failedUntil.set(key, now() + Math.min(20_000, ttl));
        if (failedUntil.size > 2_000) failedUntil.delete(failedUntil.keys().next().value);
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
      // Every transfer the feed sees joins the store, so links build up for any wallet.
      try { ledger?.store(lists.flat().filter(Boolean)); } catch {}
      // The newest 400 are kept, so the feed grows while people watch.
      const kept = [...seen.values()].sort((left, right) => right.time - left.time).slice(0, 400);
      seen.clear();
      for (const item of kept) seen.set(item.id, item);
      return kept;
    }, { stale: true });
  }

  // Ethplorer (free key): an address's tokens with prices. Tokens held by fewer than a thousand
  // wallets are left out: spam sent to well-known wallets often carries a made-up price.
  // A token's own site icon, when its source has no logo.
  const siteIcon = (site) => {
    try {
      const url = new URL(String(site ?? ""));
      return url.protocol === "https:" ? `https://www.google.com/s2/favicons?sz=64&domain=${url.hostname.toLowerCase()}` : null;
    } catch { return null; }
  };
  async function ethplorer(address) {
    const data = await get(`https://api.ethplorer.io/getAddressInfo/${address}?apiKey=freekey`).catch(() => null);
    if (!Array.isArray(data?.tokens)) return null;
    const result = [];
    for (const item of data.tokens) {
      const info = item?.tokenInfo;
      const rate = number(info?.price?.rate);
      if (!info || !rate || !EVM_ADDRESS.test(info.address ?? "") || Number(info.holdersCount) < 1_000) continue;
      const amount = units(String(item.rawBalance ?? ""), info.decimals ?? 0);
      if (!amount || amount * rate < 0.01) continue;
      result.push({ token: { address: info.address, symbol: label(info.symbol, 20) ?? "?", name: label(info.name) ?? "",
        icon: /^\/images\/[\w./-]+$/.test(info.image ?? "") ? `https://ethplorer.io${info.image}` : siteIcon(info.website), price: rate }, amount, usd: amount * rate });
    }
    // The network coin's balance and price too, for when the explorer does not answer.
    result.native = { amount: number(data.ETH?.balance), price: number(data.ETH?.price?.rate) };
    return result;
  }

  // --- An address: what it holds on every network, with names and tags.
  async function evmHoldings(address) {
    const chains = await Promise.all(Object.entries(EXPLORERS).map(async ([chain, explorer]) => {
      try {
        // Addresses holding thousands of tokens can take the explorer minutes; the coin balance still shows.
        // Every token with a price, from Ethplorer's free API (a second or two even for thousands of tokens);
        // the explorer and the network's node stand behind it.
        const full = chain === "eth" ? Promise.race([ethplorer(address), new Promise((resolve) => { setTimeout(resolve, 8_000, null).unref?.(); })]) : Promise.resolve(null);
        // The listed tokens are read from the network's node at the same time, in case the explorer is too slow.
        const backup = nodes.listedTokens(chain, address).catch(() => null);
        // The explorer's own answer may fail (busy, or turning a server away): Ethplorer stands in for it on the main network.
        const [info, balances] = await Promise.all([get(`${explorer.api}/addresses/${address}`).catch((error) => (chain === "eth" ? null : Promise.reject(error))),
          Promise.race([get(`${explorer.api}/addresses/${address}/token-balances`),
            // With the node's copy on its way, the explorer gets a few seconds only.
            new Promise((resolve) => { setTimeout(resolve, BACKUP[chain] ? Math.min(tokenWait, 6_000) : tokenWait, undefined).unref?.(); })]).catch(() => undefined)]);
        const priced = await full;
        if (!info && !priced) throw new Error("the explorer did not answer");
        const price = number(info?.exchange_rate) ?? priced?.native?.price ?? null;
        const native = info ? units(info.coin_balance ?? "0", 18) ?? 0 : priced?.native?.amount ?? 0;
        const assets = native > 0 ? [{ chain, token: { address: null, symbol: explorer.native, name: explorer.native, icon: null, price },
          amount: native, usd: price === null ? null : native * price }] : [];
        for (const item of Array.isArray(balances) ? balances : []) {
          if (item?.token?.type !== "ERC-20" || item.token.reputation === "scam") continue;
          const coin = token(item.token);
          const amount = units(item.value, item.token.decimals);
          if (!amount || coin.price === null || amount * coin.price < 0.01) continue;
          assets.push({ chain, token: coin, amount, usd: amount * coin.price });
        }
        if (priced) {
          // Ethplorer's list replaces the explorer's: it has every token, the explorer's may be cut short.
          assets.splice(native > 0 ? 1 : 0);
          assets.push(...priced.map((item) => ({ chain, ...item })));
        }
        // The explorer did not answer in time: the largest coins' tokens come from the node instead.
        const listed = !priced && balances === undefined ? await backup : null;
        if (listed) assets.push(...listed);
        // Any trace on the network: a balance, a token, a transfer or a transaction.
        const active = Boolean(native > 0 || priced?.length || info?.has_tokens || info?.has_token_transfers || info?.has_logs || info?.creation_tx_hash || Number(info?.nonce) > 0);
        return { chain, ok: true, partial: !priced && balances === undefined, listed: Boolean(listed), active, info: info ? party({ ...info, hash: address }) : null, assets: assets.sort((left, right) => (right.usd ?? 0) - (left.usd ?? 0)).slice(0, 100) };
      } catch {
        return { chain, ok: false, info: null, assets: [] };
      }
    }));
    // The other networks, read from public nodes in one call each.
    // The node networks answer within the token wait, or show as not answering this time.
    const unanswered = () => Object.keys(NODES).map((chain) => ({ chain, ok: false, partial: false, info: null, assets: [] }));
    chains.push(...await Promise.race([nodes.holdings(address).catch(unanswered),
      new Promise((resolve) => { setTimeout(() => resolve(unanswered()), tokenWait).unref?.(); })]));
    const named = chains.map((item) => item.info).find((info) => info?.name) ?? chains.find((item) => item.info)?.info;
    return { address, kind: "evm", name: named?.name ?? null, tags: [...new Set(chains.flatMap((item) => item.info?.tags ?? []))],
      contract: chains.some((item) => item.info?.contract), networks: chains.map(({ chain, ok, partial, listed, active, sent }) => ({ chain, ok, partial: Boolean(partial), ...(listed ? { listed: true } : {}),
        active: Boolean(active) || chains.find((item) => item.chain === chain).assets.length > 0, ...(sent ? { sent } : {}) })),
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
  // A wallet seen before opens at once from its copy while a fresh one is read behind it.
  // A copy where a network did not answer is kept half a minute only, so the next visit asks again.
  async function holdings(address, { background = false } = {}) {
    const key = `holdings:${address.toLowerCase()}`;
    const value = await cached(key, 600_000, () => (addressKind(address) === "evm" ? evmHoldings(address) : utxoHoldings(address)), { stale: true, background });
    const hit = cache.get(key);
    if (hit && value?.networks?.some((item) => !item.ok)) hit.at = Math.min(hit.at, now() - 600_000 + 30_000);
    return sane(reprice(value), await nodes.coinIds().catch(() => null));
  }
  // A token whose dollar value cannot be real is left out: more than all of the coin is worth, a
  // contract no coin list knows under a large coin's ticker (a look-alike), or over a billion dollars of an
  // unknown contract. The explorers price such look-alikes at the real coin's price.
  function sane(value, ids) {
    if (!value?.assets || !ids?.contract) return value;
    const wrong = (asset) => {
      if (!asset.token?.address || !(asset.usd > 0)) return false;
      const coinId = ids.contract.get(asset.token.address.toLowerCase());
      if (coinId) return ids.cap?.has(coinId) && asset.usd > ids.cap.get(coinId);
      return asset.usd > 1e9 || (asset.usd > 1e6 && ids.symbol?.has(String(asset.token.symbol ?? "").toUpperCase()));
    };
    if (!value.assets.some(wrong)) return value;
    return { ...value, assets: value.assets.filter((asset) => !wrong(asset)) };
  }
  // The UTXO network's coin is valued at today's price when answered, not when its copy was read:
  // a copy made before the prices were in would show a balance of nothing for ten minutes.
  function reprice(value) {
    const price = value?.kind === "utxo" ? nativePrice(UTXO.native) : null;
    if (price === null) return value;
    return { ...value, assets: value.assets.map((asset) => (asset.token.address === null
      ? { ...asset, token: { ...asset.token, price }, usd: asset.amount * price } : asset)) };
  }

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
    const after = /^[0-9a-f]{64}$/.test(cursor?.after ?? "") ? cursor.after : null;
    const list = await get(`${UTXO.api}/address/${address}/txs${after ? `/chain/${after}` : ""}`);
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
  const rawTransfers = (address, chain, direction, cursor) => (addressKind(address) === "utxo" ? utxoTransfers(address, direction, cursor)
    : NODES[chain] ? nodes.addressTransfers(address, chain, direction, cursor?.before ?? null) : evmTransfers(address, chain, direction, cursor));
  function transfers(address, chain, direction, cursor) {
    const key = `transfers:${address.toLowerCase()}:${chain}:${direction}:${JSON.stringify(cursor ?? null)}`;
    return cached(key, 60_000, async () => {
      const page = await rawTransfers(address, chain, direction, cursor);
      try { ledger?.store(page.items); } catch {}
      return page;
    }, { nodes: Boolean(NODES[chain]) && addressKind(address) !== "utxo" });
  }

  // --- The crawler: a wallet's transfer pages read further back into the store. The newest page of
  // every network is read at once (again once it is ten minutes old); the older pages one request at
  // a time behind it, up to `crawlPages` a network, so the explorers are never flooded.
  const crawlJobs = [];
  const crawlActive = new Map(); // lower-case address → pages queued or being read
  const heads = new Map(); // lower-case address → its newest pages being read
  let crawlRunning = false;
  const chainsOf = (address) => (addressKind(address) === "utxo" ? [UTXO.id] : [...Object.keys(EXPLORERS), ...Object.keys(NODES)]);
  const busy = (key, step) => {
    const left = (crawlActive.get(key) ?? 0) + step;
    if (left > 0) crawlActive.set(key, left); else crawlActive.delete(key);
  };
  function enqueue(job) {
    if (crawlJobs.length >= 5_000) return;
    busy(job.address.toLowerCase(), 1);
    crawlJobs.push(job);
    if (!crawlRunning) void runCrawl();
  }
  async function runCrawl() {
    crawlRunning = true;
    while (crawlJobs.length) {
      const job = crawlJobs.shift();
      try {
        const page = await rawTransfers(job.address, job.chain, "all", job.cursor);
        ledger.store(page.items);
        const state = ledger.crawled(job.address, job.chain);
        const pages = (state?.pages ?? 1) + 1;
        const done = !page.next || pages >= crawlPages;
        ledger.markCrawled(job.address, job.chain, { headAt: state?.headAt ?? now(), cursor: page.next, done, pages });
        if (!done) enqueue({ address: job.address, chain: job.chain, cursor: page.next });
      } catch {}
      busy(job.address.toLowerCase(), -1);
      await new Promise((resolve) => { setTimeout(resolve, crawlGap).unref?.(); });
    }
    crawlRunning = false;
  }
  // Starts (or freshens) a wallet's crawl; resolves once its newest pages are in the store.
  function crawl(address) {
    const key = address.toLowerCase();
    if (heads.has(key)) return heads.get(key);
    const stale = chainsOf(address).filter((chain) => now() - (ledger.crawled(address, chain)?.headAt ?? 0) > 600_000);
    const deeper = () => {
      if (crawlActive.has(key)) return;
      for (const chain of chainsOf(address)) {
        const state = ledger.crawled(address, chain);
        if (state && !state.done && state.cursor && !NODES[chain]) enqueue({ address, chain, cursor: state.cursor });
      }
    };
    if (!stale.length) { deeper(); return Promise.resolve(); }
    busy(key, 1);
    const job = Promise.all(stale.map(async (chain) => {
      try {
        const page = await rawTransfers(address, chain, "all", null);
        ledger.store(page.items);
        const state = ledger.crawled(address, chain);
        ledger.markCrawled(address, chain, { headAt: now(), cursor: state?.cursor ?? page.next ?? null,
          done: state ? state.done : !page.next || Boolean(NODES[chain]), pages: Math.max(1, state?.pages ?? 1) });
      } catch {}
    })).then(() => { heads.delete(key); busy(key, -1); deeper(); });
    heads.set(key, job);
    return job;
  }
  // A wallet's links from the store: the other wallets in a table, each transfer as
  // [time, network, other wallet's index, 1 coming in | 0 going out, dollars].
  async function links(address) {
    const key = address.toLowerCase();
    const first = crawl(address);
    if (!ledger.rows(address, 1).length) await Promise.race([first, new Promise((resolve) => { setTimeout(resolve, 6_000).unref?.(); })]);
    const rows = ledger.rows(address, 15_000);
    const index = new Map();
    const parties = [];
    const counts = new Map();
    const out = rows.map((row) => {
      const incoming = row.to === key;
      const other = incoming ? row.from : row.to;
      if (!index.has(other)) { index.set(other, parties.length); parties.push(other); }
      counts.set(other, (counts.get(other) ?? 0) + (row.usd ?? 0) + 1);
      return [row.time, row.chain, index.get(other), incoming ? 1 : 0, row.usd === null ? null : Math.round(row.usd * 100) / 100];
    });
    // The open labels of the biggest counterparties, waited for a moment.
    const top = [...counts].sort((left, right) => right[1] - left[1]).slice(0, 60).map(([other]) => other).filter((other) => /^0x[0-9a-f]{40}$/.test(other));
    await learnNames(top.map((other) => ({ from: { address: other } })), 1_500);
    return { crawling: crawlActive.has(key), parties: parties.map((other) => {
      const party = named({ address: other });
      return { address: other, name: party.name ?? null, logo: party.logo ?? null };
    }), rows: out };
  }

  // --- An organisation as one wallet, as on the analytics sites: its holdings added up, its recent transfers
  // with its own side shown as its name, and how many addresses it has; the addresses themselves stay on
  // the server (one is shown half hidden), so the book of attributions cannot be copied off the site.
  // Each organisation's wallets are read in the background, two at a time and gently, and kept half an hour.
  const ENTITY_TTL = 30 * 60_000;
  const entityJobs = new Map(); // lower-case name → { name, at, members, holdings: Map, running }
  const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
  const masked = (address) => (address ? `${address.slice(0, Math.ceil(address.length / 2))}…` : null);
  function entityJob(name, extra) {
    const key = name.toLowerCase();
    let job = entityJobs.get(key);
    if (!job || now() - job.at > ENTITY_TTL) {
      job = { name, at: now(), members: [], holdings: new Map(), running: false };
      entityJobs.delete(key);
      entityJobs.set(key, job);
      if (entityJobs.size > 200) entityJobs.delete(entityJobs.keys().next().value);
    }
    const seen = new Set(job.members.map((address) => address.toLowerCase()));
    for (const address of [...extra, ...names.members(name, 300).map((item) => item.address)]) {
      if (!seen.has(address.toLowerCase())) { seen.add(address.toLowerCase()); job.members.push(address); }
    }
    if (!job.running && job.holdings.size < job.members.length) void fillEntity(job);
    return job;
  }
  async function fillEntity(job) {
    job.running = true;
    let next = 0;
    const worker = async () => {
      while (next < job.members.length) {
        const address = job.members[next++];
        if (job.holdings.has(address)) continue;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try { job.holdings.set(address, await holdings(address, { background: true })); break; } catch { await pause(10_000); }
        }
        if (!job.holdings.has(address)) job.holdings.set(address, null);
        await pause(1_000);
      }
    };
    await Promise.all([worker(), worker()]).catch(() => {});
    job.running = false;
    // Wallets that did not answer are tried again a little later (twice at most), not counted as read.
    const failed = [...job.holdings].filter(([, value]) => value === null).map(([address]) => address);
    job.failed = failed.length;
    if (failed.length && (job.retries ?? 0) < 2) {
      job.retries = (job.retries ?? 0) + 1;
      await pause(60_000);
      for (const address of failed) job.holdings.delete(address);
      if (!job.running) void fillEntity(job);
    }
  }
  // The organisation's recent transfers from the store: its own side carries its name, not an address.
  function entityTransfers(name, members, limit = 60) {
    const own = new Set(members.map((address) => address.toLowerCase()));
    const self = { address: `entity:${name}`, name };
    const seen = new Set();
    return members.slice(0, 80).flatMap((address) => ledger?.rows(address, 40) ?? [])
      .filter((row) => !seen.has(row.id) && seen.add(row.id) && own.has(row.from) !== own.has(row.to))
      .sort((left, right) => right.time - left.time).slice(0, limit)
      .map((row) => ({ id: row.id, chain: row.chain, time: row.time, amount: row.amount, usd: row.usd,
        token: { address: null, symbol: row.symbol ?? "", name: row.symbol ?? "", icon: null, price: null },
        from: own.has(row.from) ? self : named({ address: row.from }), to: own.has(row.to) ? self : named({ address: row.to }) }));
  }
  // An organisation's links for the bubbles (/visualizer/?address=entity:<name>): its members' transfers from the
  // store, with the organisation as one bubble in the middle (its addresses are not given out), transfers between
  // its own wallets left out. Members without stored transfers are read in the background, a few at a time.
  function entityLinks(name) {
    const satoshi = /^satoshi nakamoto$/i.test(name) && patoshi;
    const members = satoshi ? ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"] : entityJob(name, []).members.slice(0, 80);
    const own = new Set(members.map((address) => address.toLowerCase()));
    let started = 0;
    for (const address of members) if (!ledger.rows(address, 1).length && !crawlActive.has(address.toLowerCase()) && started++ < 6) void crawl(address);
    const index = new Map();
    const parties = [];
    const rows = [];
    const seen = new Set();
    for (const address of members) {
      for (const row of ledger.rows(address, 3_000)) {
        if (seen.has(row.id) || own.has(row.from) === own.has(row.to)) continue;
        seen.add(row.id);
        const incoming = own.has(row.to);
        const other = incoming ? row.from : row.to;
        if (!index.has(other)) { index.set(other, parties.length); parties.push(other); }
        rows.push([row.time, row.chain, index.get(other), incoming ? 1 : 0, row.usd === null ? null : Math.round(row.usd * 100) / 100]);
      }
    }
    return { crawling: members.some((address) => crawlActive.has(address.toLowerCase())), parties: parties.map((other) => {
      const party = named({ address: other });
      return { address: other, name: party.name ?? null, logo: party.logo ?? null };
    }), rows: rows.sort((left, right) => right[0] - left[0]).slice(0, 15_000) };
  }
  function entitySummary(name, extra = []) {
    const category = names.entityCategory(name);
    // Satoshi Nakamoto: his early blocks' coins, read key by key (market-patoshi.mjs).
    if (/^satoshi nakamoto$/i.test(name) && patoshi) {
      const coins = patoshi.summary();
      const rate = nativePrice(UTXO.native);
      const genesis = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
      return { name, category: "individual", count: coins.keys, loaded: coins.checked, done: coins.done, sample: masked(genesis),
        total: rate === null ? null : coins.estimate * rate, assets: [{ chain: UTXO.id, token: { address: null, symbol: UTXO.native, name: UTXO.native, icon: null, price: rate },
          amount: coins.estimate, usd: rate === null ? null : coins.estimate * rate }], transfers: entityTransfers(name, [genesis]) };
    }
    const job = entityJob(name, extra);
    const assets = new Map();
    for (const data of job.holdings.values()) {
      for (const asset of data?.assets ?? []) {
        const key = `${asset.chain}:${String(asset.token.address ?? asset.token.symbol).toLowerCase()}`;
        const entry = assets.get(key) ?? { chain: asset.chain, token: asset.token, amount: 0, usd: 0 };
        entry.amount += asset.amount;
        entry.usd += asset.usd ?? 0;
        assets.set(key, entry);
      }
    }
    const list = [...assets.values()].sort((left, right) => right.usd - left.usd);
    const logo = names.members(name, 300).find((item) => item.logo)?.logo ?? null;
    const read = [...job.holdings.values()].filter(Boolean).length;
    return { name, category, logo, count: job.members.length, loaded: read, failed: job.failed ?? 0,
      done: !job.running && job.holdings.size >= job.members.length && (!job.failed || (job.retries ?? 0) >= 2),
      sample: masked(job.members[0]), total: list.reduce((sum, asset) => sum + asset.usd, 0), assets: list.slice(0, 100),
      transfers: entityTransfers(name, job.members) };
  }

  // --- The network coin's balance by day, from the explorer.
  function history(address, chain) {
    return cached(`history:${address.toLowerCase()}:${chain}`, 600_000, async () => {
      const data = await get(`${EXPLORERS[chain].api}/addresses/${address}/coin-balance-history-by-day`);
      return (data?.items ?? []).map((item) => [Date.parse(item.date), units(item.value, 18)]).filter(([time, value]) => time && value !== null)
        .sort((left, right) => left[0] - right[0]);
    });
  }

  // --- Search: an address as it is, or wallets by name, as the analytics sites find entities: the
  // explorer's quick search brings the open labels (BlackRock: Digital Asset Fund, Wintermute 2…),
  // name-service names and verified labels, people's wallets ahead of contracts, with their pictures.
  // NIR Markets' own book of wallet names (market-names.mjs) answers first, then the live sources,
  // whose finds join the book.
  async function search(query) {
    const text = query.trim();
    if (addressKind(text)) return [{ address: text, name: null, kind: addressKind(text) }];
    if (text.length < 3 || text.length > 60) return [];
    const local = names.search(text, 8).map((item) => ({ address: item.address, name: item.name, entity: item.entity, logo: item.logo, contract: false, kind: "evm" }));
    const live = await liveSearch(text).catch(() => []);
    // A wallet both know shows in the book's place with the live details (its kind, a fresh picture).
    const fresh = new Map(live.map((item) => [item.address.toLowerCase(), item]));
    const seen = new Set(local.map((item) => item.address.toLowerCase()));
    return [...local.map((item) => ({ ...item, ...fresh.get(item.address.toLowerCase()) })),
      ...live.filter((item) => !seen.has(item.address.toLowerCase()))].slice(0, 12);
  }
  function liveSearch(text) {
    return cached(`search:${text.toLowerCase()}`, 3_600_000, async () => {
      // "black rock" is also asked as "blackrock": organisations are often labelled as one word.
      const asked = [...new Set([text, text.replace(/\s+/g, "")])].filter((query) => query.length >= 3);
      const answers = await Promise.all(asked.map((query) => get(`${EXPLORERS.eth.api}/search/quick?q=${encodeURIComponent(query)}`).catch(() => [])));
      const found = new Map();
      for (const item of answers.flatMap((data) => (Array.isArray(data) ? data : data?.items ?? []))) {
        const address = item?.address_hash ?? item?.address ?? "";
        if (!EVM_ADDRESS.test(address) || !["metadata_tag", "ens_domain", "address", "label"].includes(item.type)) continue;
        const tag = item.type === "metadata_tag" ? item.metadata : null;
        const name = label(tag?.tagType === "name" ? tag.name : item.ens_info?.name ?? item.name ?? tag?.name);
        // Collectors' handles copied from marketplaces ("_zeus1" on OpenSea) are not entities.
        if (!name || /^["“]/.test(name)) continue;
        const key = address.toLowerCase();
        const entry = found.get(key) ?? { address, name, entity: null, contract: Boolean(item.is_smart_contract_address), kind: "evm", ...(item.type === "ens_domain" ? { ens: true } : {}) };
        // A name tag names the wallet; a protocol or generic tag names its organisation.
        if (tag && tag.tagType !== "name") entry.entity ??= label(tag.name);
        else if (tag) entry.name = name;
        found.set(key, entry);
      }
      // A person is often found by the name-service name made of their name: "James Wynn" →
      // jameswynn.eth, james-wynn.eth, jwynn.eth, wynn.eth. Each that exists comes first, shown as it is.
      const words = text.toLowerCase().split(/\s+/).map((word) => word.replace(/[^a-z0-9]/g, "")).filter(Boolean);
      const guesses = text.includes(".") || !words.length ? [] : [...new Set([words.join(""), words.join("-"),
        words.length > 1 ? `${words[0][0]}${words.at(-1)}` : ""])]
        .filter((guess) => /^[a-z0-9-]{3,40}$/.test(guess)).slice(0, 4);
      const named = (await Promise.all(guesses.map((guess) => get(`${EXPLORERS.eth.api}/search/quick?q=${guess}.eth`).then((answer) =>
        (Array.isArray(answer) ? answer : []).find((item) => item?.type === "ens_domain" && item.ens_info?.name === `${guess}.eth` && EVM_ADDRESS.test(item.address_hash ?? "")))
        .catch(() => null)))).filter(Boolean);
      for (const item of named.reverse()) {
        const key = item.address_hash.toLowerCase();
        // A wallet the open labels already name keeps that name.
        if (!found.has(key)) found.set(key, { address: item.address_hash, name: item.ens_info.name, entity: null, contract: false, kind: "evm", ens: true });
      }
      // OpenSea usernames made of the words ("James Wynn" → jameswynn, james_wynn), when a key is set:
      // shown as OpenSea profiles, checked when they link an X account.
      const handles = opensea && !text.includes(".") ? [...new Set([words.join(""), words.join("_")])].filter((handle) => /^[a-z0-9_]{3,40}$/.test(handle)) : [];
      const profiles = (await Promise.all(handles.map((handle) => opensea.account(handle).catch(() => null)))).filter(Boolean);
      for (const profile of profiles) {
        const key = profile.address.toLowerCase();
        if (!found.has(key)) found.set(key, { address: profile.address, name: profile.username, entity: profile.x ? `OpenSea · @${profile.x}` : "OpenSea",
          logo: profile.picture, contract: false, kind: "evm", opensea: true, checked: profile.checked });
      }
      // Labelled wallets and checked profiles first, then name-service names and unchecked profiles, then contracts.
      const rank = (item) => (item.contract ? 2 : item.ens || (item.opensea && !item.checked) ? 1 : 0);
      const results = [...found.values()].sort((left, right) => rank(left) - rank(right)).slice(0, 10);
      await names.lookup(results.map((item) => item.address)).catch(() => {});
      const answer = results.map((item) => {
        const open = names.name(item.address);
        return { ...item, entity: item.entity ?? open?.entity ?? null, logo: open?.logo ?? item.logo ?? null };
      });
      // Labelled wallets and name-service names join the book; contracts do not.
      names.remember(answer.filter((item) => !item.contract), "search");
      return answer;
    });
  }

  // Each asset gets the id of its coin page here, by contract address or, for a network coin, by symbol.
  async function withCoinIds(data) {
    const ids = await nodes.coinIds().catch(() => null);
    if (!ids) return data;
    return { ...data, assets: data.assets.map((asset) => {
      const coinId = asset.token.address ? ids.contract.get(asset.token.address.toLowerCase()) ?? null : ids.symbol.get(asset.token.symbol) ?? null;
      // The coin's logo, else the source's own picture; kept on this server when it has a picture store.
      const sources = [coinId ? ids.image?.get(coinId) : null, asset.token.icon];
      const icon = logos ? logos.url(asset.chain, asset.token.address, asset.token.symbol, sources) : sources.find(Boolean) ?? null;
      return { ...asset, token: { ...asset.token, coinId, icon } };
    }) };
  }
  // The feed is refreshed in the background, so a visitor never waits for the explorers.
  // The whales list is counted off the main thread at most every ten minutes; asked between, the last
  // count answers at once (the first visitor after a start waits for the first count).
  let whaleRows = null;
  let whalesAt = 0;
  let whalesCounting = null;
  function whales() {
    if (!ledger) return Promise.resolve([]);
    if (!whalesCounting && now() - whalesAt > 600_000) {
      whalesCounting = (ledger.busiestLater ?? (async (since, limit) => ledger.busiest(since, limit)))(now() - 30 * 86_400_000, 300)
        .then((rows) => {
          whaleRows = rows;
          whalesAt = now();
          // Wallets without a name of their own are checked for code, one at a time: a contract leaves the list.
          void (async () => { for (const row of rows) { const known = names.name(row.address); if (!known?.name || known.guessed) await hasCode(row.address); } })().catch(() => {});
        }, () => {})
        .finally(() => { whalesCounting = null; });
    }
    return whaleRows ? Promise.resolve(whaleRows) : (whalesCounting ?? Promise.resolve()).then(() => whaleRows ?? []);
  }

  function warm(every = 15_000) {
    void whales();
    const tick = () => { void feed().catch(() => {}); };
    tick();
    const timer = setInterval(tick, every);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // Names approved by NIR Markets moderators (market-labels.mjs) go ahead of the explorers' labels,
  // and those ahead of the open labels (market-names.mjs), which also bring the owner's picture.
  const named = (party) => {
    if (!party?.address) return party;
    const open = names.name(party.address);
    const withOpen = open ? { ...party, name: party.name ?? open.name, logo: open.logo, ...(open.entity ? { entity: open.entity } : {}),
      ...(open.category ? { category: open.category, ...(open.guessed ? { guessed: true } : {}) } : {}) } : party;
    const name = labelFor(party.address);
    const result = name ? { ...withOpen, name, tags: ["NIR Markets", ...(party.tags ?? []).filter((tag) => tag !== "NIR Markets")] } : withOpen;
    // A wallet with a name goes out under its id, never its address (market-masks.mjs).
    return masks ? masks.mask(result) : result;
  };
  const relabel = (items) => items.map((item) => ({ ...item, from: named(item.from), to: named(item.to) }));
  // The open labels of every address in the list: waited for up to `wait` milliseconds, then the
  // rest comes on the next request.
  const learn = (items, wait) => {
    // Name-service names seen in transfers join the book too.
    names.remember(items.flatMap((item) => [item.from, item.to]).filter((party) => /\.eth$/i.test(party?.name ?? "")), "ens");
    return learnNames(items, wait);
  };
  const learnNames = (items, wait) => Promise.race([names.lookup(items.flatMap((item) => [item.from?.address, item.to?.address])),
    new Promise((resolve) => { setTimeout(resolve, wait).unref?.(); })]);
  // `hide`: a known wallet asked for by its id — its address is replaced by the id wherever the answer has it.
  const reply = (response, status, body, maxAge = 15, hide = null) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=${maxAge}` : "no-store" });
    let text = JSON.stringify(body);
    if (hide) text = text.replace(new RegExp(hide.address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), hide.id);
    response.end(text);
  };
  // An address as asked: a full one, or a known wallet's id ("w:…") resolved on the server.
  const resolveAsked = (value) => (MASKED.test(value ?? "") ? masks?.addressOf(value) ?? null : value);
  // Answers GET /market/chain/..., or returns false.
  async function handle(request, response, url) {
    const path = url.pathname;
    // Token pictures kept on this server (market-logos.mjs).
    if (logos && path.startsWith("/market/logo/")) return logos.handle(request, response, url);
    if (!path.startsWith("/market/chain/")) return false;
    if (request.method !== "GET") return reply(response, 405, { error: "read only" }), true;
    try {
      if (path === "/market/chain/feed") {
        const min = Math.max(0, Number(url.searchParams.get("min")) || 0);
        const chain = url.searchParams.get("chain");
        const chosen = (await feed()).filter((item) => (item.usd ?? 0) >= min && (!chain || item.chain === chain)).slice(0, 200);
        await learn(chosen, 300);
        const items = relabel(chosen);
        return reply(response, 200, { networks: [...Object.keys(EXPLORERS), ...Object.keys(NODES)], items }, 10), true;
      }
      // GET /market/chain/popular?group=whales: the wallets the most money moved through in 30 days (NIR Markets'
      // own store of transfers), with their names when known; ?group=found: names found from behaviour, newest first.
      if (path === "/market/chain/popular" && ["whales", "found"].includes(url.searchParams.get("group"))) {
        const ids = await nodes.coinIds().catch(() => null);
        const notWallet = (address, name) => ids?.contract?.has(String(address).toLowerCase()) || /^0x0{40}$/i.test(address) || knownContract(address)
          || /router|pool|bridge|swap|vault|aggregator|wrapped|token/i.test(name ?? "");
        const items = url.searchParams.get("group") === "found"
          ? names.found(200).map((row) => ({ address: row.address, name: row.name, entity: row.entity, category: row.category, found: row.at, guessed: true }))
          : (await whales()).map((row) => {
            const known = names.name(row.address);
            return { address: row.address, name: known?.name ?? null, entity: known?.entity ?? null, logo: known?.logo ?? null, category: known?.category ?? null,
              guessed: Boolean(known?.guessed), moved: row.usd, transfers: row.transfers };
          });
        return reply(response, 200, { items: items.filter((item) => !notWallet(item.address, item.name)).slice(0, 150).map((item) => (masks ? masks.mask(item) : item)), next: null }, 600), true;
      }
      // GET /market/chain/popular?group=exchange|fund|hot-wallet&cursor=…: a page of known wallets.
      if (path === "/market/chain/popular") {
        const cursor = url.searchParams.get("cursor");
        // The page's cursor is a wallet too: it travels as its id.
        const from = resolveAsked(cursor);
        const page = await names.directory(url.searchParams.get("group") ?? "", from && /^0x[0-9a-fA-F]{40}$/.test(from) ? from : null);
        if (!page) return reply(response, 404, { error: "unknown group" }), true;
        // A token's own contract is no wallet (a fund's token carries the fund's name): those are left out.
        const ids = await nodes.coinIds().catch(() => null);
        if (ids?.contract) page.items = page.items.filter((item) => !ids.contract.has(String(item.address).toLowerCase()));
        return reply(response, 200, { ...page, items: page.items.map((item) => (masks ? masks.mask(item) : item)),
          next: page.next && masks ? `w:${masks.idOf(page.next)}` : page.next }, 3600), true;
      }
      // GET /market/chain/entity?name=…&extra=…: an organisation as one wallet (entitySummary: its holdings added up, its transfers, how many addresses);
      // GET /market/chain/entities?names=a,b,… (60 at most): how many each has.
      // GET /market/chain/satoshi: Satoshi Nakamoto's early coins (market-patoshi.mjs).
      if (path === "/market/chain/satoshi") {
        if (!patoshi) return reply(response, 404, { error: "not kept here" }), true;
        return reply(response, 200, { ...patoshi.summary(), price: nativePrice(UTXO.native) }, 60), true;
      }
      if (path === "/market/chain/entity") {
        const name = (url.searchParams.get("name") ?? "").trim().slice(0, 60);
        if (name.length < 2) return reply(response, 400, { error: "a name, please" }), true;
        // The popular list's public wallets of the organisation, which the page knows already, may join in.
        const extra = (url.searchParams.get("extra") ?? "").split(",").map((value) => resolveAsked(value)).filter((address) => addressKind(address)).slice(0, 30);
        return reply(response, 200, entitySummary(name, extra), 5), true;
      }
      if (path === "/market/chain/entities") {
        const wanted = (url.searchParams.get("names") ?? "").split(",").map((item) => item.trim()).filter((item) => item.length >= 2 && item.length <= 60).slice(0, 60);
        return reply(response, 200, { counts: Object.fromEntries(wanted.map((item) => [item, names.members(item, 300).length])) }, 600), true;
      }
      // GET /market/chain/names?addresses=a,b,… (50 at most): the open labels of those wallets.
      if (path === "/market/chain/names") {
        const wanted = (url.searchParams.get("addresses") ?? "").split(",").filter((address) => /^0x[0-9a-fA-F]{40}$/.test(address)).slice(0, 50);
        await names.lookup(wanted);
        const found = Object.fromEntries(wanted.map((address) => [address.toLowerCase(), names.name(address)]).filter(([, value]) => value));
        return reply(response, 200, { names: found }, 3600), true;
      }
      if (path === "/market/chain/search") {
        const results = (await search(url.searchParams.get("q") ?? "")).map((item) => ({ ...item, name: labelFor(item.address) ?? item.name }))
          .map((item) => (masks ? masks.mask(item) : item));
        return reply(response, 200, { results }, 300), true;
      }
      // GET /market/chain/totals?addresses=a,b,…: each wallet's last whole balance the server knows (at once,
      // no fetching); the ones asked are kept fresh in the background, so lists show their sums straight away.
      if (path === "/market/chain/totals") {
        // Known wallets are asked by their ids and answered under them.
        const asked = [...new Set((url.searchParams.get("addresses") ?? "").split(","))].map((value) => [value, resolveAsked(value)])
          .filter(([, address]) => addressKind(address)).slice(0, 200)
          // One wallet is one sum, whatever the letters' case of its address.
          .map(([value, address]) => [value, addressKind(address) === "evm" ? address.toLowerCase() : address]);
        for (const [, address] of asked) followTotal(address);
        return reply(response, 200, { totals: Object.fromEntries(asked.map(([value, address]) => [value, totals.get(address) ?? null])) }, 30), true;
      }
      // GET /market/chain/address/entity:<name>/links: an organisation's links for the bubbles (entityLinks).
      let plainPath = path;
      try { plainPath = decodeURIComponent(path); } catch {}
      const entityMatch = ledger && /^\/market\/chain\/address\/entity:([^/]{2,60})\/links$/.exec(plainPath);
      if (entityMatch) return reply(response, 200, entityLinks(entityMatch[1].trim()), 10), true;
      const match = /^\/market\/chain\/address\/([^/]+)(?:\/(transfers|history|links))?$/.exec(path);
      let asked = match?.[1] ?? "";
      try { asked = decodeURIComponent(asked); } catch {}
      const address = resolveAsked(asked);
      if (!match || !address || !addressKind(address)) return reply(response, 404, { error: "not an address" }), true;
      const part = match[2];
      const hide = MASKED.test(asked) ? { address, id: asked } : null;
      const answer = (status, body, maxAge) => reply(response, status, body, maxAge, hide);
      if (!part) {
        const [data] = await Promise.all([holdings(address).then(withCoinIds), learn([{ from: { address } }], 2_000)]);
        noteTotal(addressKind(address) === "evm" ? address.toLowerCase() : address, data);
        const own = labelFor(address);
        let open = names.name(address);
        // A wallet no label names may have an OpenSea profile: its username, picture and linked X account.
        if (!open && !own && opensea && addressKind(address) === "evm") {
          const profile = await Promise.race([opensea.account(address), new Promise((resolve) => { setTimeout(resolve, 2_500, null).unref?.(); })]);
          if (profile) {
            names.remember([{ address, name: profile.username, entity: profile.x ? `OpenSea · @${profile.x}` : "OpenSea", logo: profile.picture }], "opensea");
            open = { name: profile.username, entity: null, site: profile.x ? `https://x.com/${profile.x}` : null, logo: profile.picture };
          }
        }
        const labelled = open ? { ...data, name: data.name ?? open.name, logo: open.logo, site: open.site,
          category: open.category ?? null, ...(open.guessed ? { guessed: true } : {}) } : data;
        // A short browser cache: the server keeps its own copy, and a newly approved name shows at once.
        const whole = own ? { ...labelled, name: own, tags: ["NIR Markets", ...data.tags] } : labelled;
        return answer(200, hide ? { ...whole, short: short(address) } : whole, 5), true;
      }
      // GET …/links: the wallet's transfers from NIR Markets' own store, for the bubbles.
      if (part === "links") {
        if (!ledger) return reply(response, 404, { error: "no transfer store" }), true;
        return answer(200, await links(address), 5), true;
      }
      const chain = addressKind(address) === "utxo" ? UTXO.id : url.searchParams.get("chain") ?? "eth";
      if (chain !== UTXO.id && !Object.hasOwn(EXPLORERS, chain) && !Object.hasOwn(NODES, chain)) return reply(response, 404, { error: "unknown network" }), true;
      if (part === "history") {
        // Balance history needs an explorer; the node networks have none.
        if (!EXPLORERS[chain]) return answer(200, { chain, points: [] }, 600), true;
        return answer(200, { chain, symbol: EXPLORERS[chain].native, points: await history(address, chain) }, 600), true;
      }
      const direction = ["in", "out"].includes(url.searchParams.get("dir")) ? url.searchParams.get("dir") : "all";
      let cursor = null;
      try { cursor = url.searchParams.get("cursor") ? JSON.parse(Buffer.from(url.searchParams.get("cursor"), "base64url").toString("utf8")) : null; } catch {}
      if (cursor !== null && (typeof cursor !== "object" || JSON.stringify(cursor).length > 600)) cursor = null;
      const page = await transfers(address, chain, direction, cursor);
      await learn(page.items, 2_000);
      return answer(200, { chain, items: relabel(page.items), next: page.next ? Buffer.from(JSON.stringify(page.next)).toString("base64url") : null,
        ...(page.reached ? { reached: page.reached } : {}) }, 30), true;
    } catch (error) {
      return reply(response, error?.status === 503 ? 503 : 502, { error: "the explorer is unavailable, try again in a minute" }), true;
    }
  }

  // Wallet totals for the lists (popular wallets, whales): the last whole answer of each, kept on disk, and the
  // wallets lists asked for refreshed every quarter of an hour, two at a time.
  const totals = new Map(); // address → { total, chains, at }
  const followed = new Map(); // address → last asked
  const totalsFile = namesFile && namesFile !== ":memory:" ? namesFile.replace(/[^/\\]+$/, "totals.json") : null;
  try { if (totalsFile) for (const [address, value] of Object.entries(JSON.parse(readFileSync(totalsFile, "utf8")))) totals.set(address, value); } catch {}
  function noteTotal(address, data) {
    if (!data?.assets) return;
    // A partial answer (tokens not counted yet, or a network that did not answer) does not replace a whole one.
    const partial = (data.networks ?? []).some((item) => item.partial || !item.ok);
    if (partial && totals.has(address)) return;
    totals.set(address, { total: data.assets.reduce((sum, asset) => sum + (asset.usd ?? 0), 0), chains: [...new Set(data.assets.map((asset) => asset.chain))], at: now(), partial });
  }
  function followTotal(address) {
    if (!followed.has(address) && followed.size >= 1_000) followed.delete(followed.keys().next().value);
    followed.set(address, now());
    if (!totals.has(address)) void refreshTotals();
  }
  let refreshing = null;
  function refreshTotals() {
    refreshing ??= (async () => {
      // The ones never counted first, then the stalest; a wallet nobody asked about for a day is let go.
      const due = [...followed].filter(([, asked]) => now() - asked < 86_400_000).map(([address]) => address)
        .filter((address) => now() - (totals.get(address)?.at ?? 0) > 15 * 60_000 || totals.get(address)?.partial)
        .sort((left, right) => (totals.get(left)?.at ?? 0) - (totals.get(right)?.at ?? 0));
      for (let index = 0; index < due.length; index += 2) {
        await Promise.all(due.slice(index, index + 2).map((address) => holdings(address, { background: true }).then((data) => noteTotal(address, data)).catch(() => null)));
      }
      if (totalsFile) { try { writeFileSync(totalsFile, JSON.stringify(Object.fromEntries(totals))); } catch {} }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  const totalsTimer = setInterval(() => { void refreshTotals(); }, 5 * 60_000);
  totalsTimer.unref?.();

  // Whether an address is a contract on any of the networks with a public node (code there): a contract
  // is no one's wallet, so guesses from behaviour leave it out. Kept for the service's life.
  const codeOf = new Map(); // lower-case address → true | false
  async function hasCode(address) {
    const key = String(address ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(key)) return false;
    if (codeOf.has(key)) return codeOf.get(key);
    const answers = await Promise.all([...Object.values(NODES), BACKUP.eth].filter((node) => node?.rpc)
      .map((node) => rpc(node.rpc, "eth_getCode", [key, "latest"]).then((code) => (typeof code === "string" ? code.length > 2 : null), () => null)));
    // Not one node answered: unknown, asked again next time.
    if (answers.every((answer) => answer === null)) return false;
    const found = answers.some(Boolean);
    if (codeOf.size > 50_000) codeOf.delete(codeOf.keys().next().value);
    codeOf.set(key, found);
    return found;
  }
  const knownContract = (address) => codeOf.get(String(address ?? "").toLowerCase()) === true;

  return { handle, feed, holdings, transfers, history, search, warm, names, links, crawl, hasCode, coinOfSymbol: nodes.coinOfSymbol, platformsOf: nodes.platformsOf, patoshi, platform: nodes.platform, networks: [...Object.keys(EXPLORERS), ...Object.keys(NODES), UTXO.id] };
}
