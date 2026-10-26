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
  labelFor = () => null, namesFile = ":memory:", names = createNames({ get, now, file: namesFile }), logos = null } = {}) {
  const cache = new Map();
  const pending = new Map();
  let used = [];
  // Cached fetch: a fresh copy within ttl; past the budget a stale copy, or an error the page can show.
  // `stale`: an expired copy is answered at once while a fresh one is fetched behind it.
  // `nodes`: work on the public nodes, which has a budget of its own (the nodes keep their own pace,
  // one request at a time, so a flood of new wallets must not queue up behind each other).
  let nodeUsed = [];
  const failedUntil = new Map(); // key → time before which a lookup that failed without a copy is not tried again
  async function cached(key, ttl, load, { stale = false, nodes: onNodes = false } = {}) {
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
    if (spent.length >= (onNodes ? 30 : perMinute)) {
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
        const [info, balances] = await Promise.all([get(`${explorer.api}/addresses/${address}`),
          Promise.race([get(`${explorer.api}/addresses/${address}/token-balances`),
            // With the node's copy on its way, the explorer gets a few seconds only.
            new Promise((resolve) => { setTimeout(resolve, BACKUP[chain] ? Math.min(tokenWait, 6_000) : tokenWait, undefined).unref?.(); })]).catch(() => undefined)]);
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
        const priced = await full;
        if (priced) {
          // Ethplorer's list replaces the explorer's: it has every token, the explorer's may be cut short.
          assets.splice(native > 0 ? 1 : 0);
          assets.push(...priced.map((item) => ({ chain, ...item })));
        }
        // The explorer did not answer in time: the largest coins' tokens come from the node instead.
        const listed = !priced && balances === undefined ? await backup : null;
        if (listed) assets.push(...listed);
        // Any trace on the network: a balance, a token, a transfer or a transaction.
        const active = Boolean(native > 0 || info?.has_tokens || info?.has_token_transfers || info?.has_logs || info?.creation_tx_hash || Number(info?.nonce) > 0);
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
  const holdings = async (address) => reprice(await cached(`holdings:${address.toLowerCase()}`, 600_000,
    () => (addressKind(address) === "evm" ? evmHoldings(address) : utxoHoldings(address)), { stale: true }));
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
  function transfers(address, chain, direction, cursor) {
    const key = `transfers:${address.toLowerCase()}:${chain}:${direction}:${JSON.stringify(cursor ?? null)}`;
    return cached(key, 60_000, async () => (addressKind(address) === "utxo" ? utxoTransfers(address, direction, cursor)
      : NODES[chain] ? nodes.addressTransfers(address, chain, direction, cursor?.before ?? null) : evmTransfers(address, chain, direction, cursor)),
    { nodes: Boolean(NODES[chain]) && addressKind(address) !== "utxo" });
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
      // Labelled wallets of the organisation or person first, then the name-service names, then contracts.
      const rank = (item) => (item.contract ? 2 : item.ens ? 1 : 0);
      const results = [...found.values()].sort((left, right) => rank(left) - rank(right)).slice(0, 10);
      await names.lookup(results.map((item) => item.address)).catch(() => {});
      const answer = results.map((item) => {
        const open = names.name(item.address);
        return { ...item, entity: item.entity ?? open?.entity ?? null, logo: open?.logo ?? null };
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
  function warm(every = 15_000) {
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
    const withOpen = open ? { ...party, name: party.name ?? open.name, logo: open.logo, ...(open.entity ? { entity: open.entity } : {}) } : party;
    const name = labelFor(party.address);
    return name ? { ...withOpen, name, tags: ["NIR Markets", ...(party.tags ?? []).filter((tag) => tag !== "NIR Markets")] } : withOpen;
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
  const reply = (response, status, body, maxAge = 15) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=${maxAge}` : "no-store" });
    response.end(JSON.stringify(body));
  };
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
      // GET /market/chain/popular?group=exchange|fund|hot-wallet&cursor=…: a page of known wallets.
      if (path === "/market/chain/popular") {
        const cursor = url.searchParams.get("cursor");
        const page = await names.directory(url.searchParams.get("group") ?? "", cursor && /^0x[0-9a-fA-F]{40}$/.test(cursor) ? cursor : null);
        if (!page) return reply(response, 404, { error: "unknown group" }), true;
        return reply(response, 200, page, 3600), true;
      }
      // GET /market/chain/names?addresses=a,b,… (50 at most): the open labels of those wallets.
      if (path === "/market/chain/names") {
        const wanted = (url.searchParams.get("addresses") ?? "").split(",").filter((address) => /^0x[0-9a-fA-F]{40}$/.test(address)).slice(0, 50);
        await names.lookup(wanted);
        const found = Object.fromEntries(wanted.map((address) => [address.toLowerCase(), names.name(address)]).filter(([, value]) => value));
        return reply(response, 200, { names: found }, 3600), true;
      }
      if (path === "/market/chain/search") {
        const results = (await search(url.searchParams.get("q") ?? "")).map((item) => ({ ...item, name: labelFor(item.address) ?? item.name }));
        return reply(response, 200, { results }, 300), true;
      }
      const match = /^\/market\/chain\/address\/([^/]+)(?:\/(transfers|history))?$/.exec(path);
      if (!match || !addressKind(match[1])) return reply(response, 404, { error: "not an address" }), true;
      const [, address, part] = match;
      if (!part) {
        const [data] = await Promise.all([holdings(address).then(withCoinIds), learn([{ from: { address } }], 2_000)]);
        const own = labelFor(address);
        const open = names.name(address);
        const labelled = open ? { ...data, name: data.name ?? open.name, logo: open.logo, site: open.site } : data;
        // A short browser cache: the server keeps its own copy, and a newly approved name shows at once.
        return reply(response, 200, own ? { ...labelled, name: own, tags: ["NIR Markets", ...data.tags] } : labelled, 5), true;
      }
      const chain = addressKind(address) === "utxo" ? UTXO.id : url.searchParams.get("chain") ?? "eth";
      if (chain !== UTXO.id && !Object.hasOwn(EXPLORERS, chain) && !Object.hasOwn(NODES, chain)) return reply(response, 404, { error: "unknown network" }), true;
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
      await learn(page.items, 2_000);
      return reply(response, 200, { chain, items: relabel(page.items), next: page.next ? Buffer.from(JSON.stringify(page.next)).toString("base64url") : null,
        ...(page.reached ? { reached: page.reached } : {}) }, 30), true;
    } catch (error) {
      return reply(response, error?.status === 503 ? 503 : 502, { error: "the explorer is unavailable, try again in a minute" }), true;
    }
  }

  return { handle, feed, holdings, transfers, history, search, warm, names, platform: nodes.platform, networks: [...Object.keys(EXPLORERS), ...Object.keys(NODES), UTXO.id] };
}
