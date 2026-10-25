// NIR Markets (nircoin.com): prices of the top 100 coins, the whole market,
// what is trending and the Fear & Greed index. The server fetches them once a
// minute and serves every visitor from that copy, so the free data sources
// see one client however many people open the page.
//
// A coin's own page (/coin/<id>) asks for that coin's details and price
// history. Those are fetched when someone opens the page, kept for a few
// minutes and capped at a number of fetches a minute, so a crowd on one coin
// or a crawler walking every coin cannot spend the free CoinGecko limit.
//
// Sources: CoinGecko (prices, market, trending; credited on the page) and
// alternative.me (Fear & Greed). COINGECKO_API_KEY adds a free demo key.
import { createServer } from "node:http";

const COINGECKO = "https://api.coingecko.com/api/v3";
const FEAR_GREED = "https://api.alternative.me/fng/?limit=1";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export async function fetchJson(url, { apiKey = process.env.COINGECKO_API_KEY } = {}) {
  const headers = { accept: "application/json" };
  if (apiKey && url.startsWith(COINGECKO)) headers["x-cg-demo-api-key"] = apiKey;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw Object.assign(new Error(`${new URL(url).host} answered ${response.status}`), { status: response.status });
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error("market response is too large");
  return JSON.parse(text);
}

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value, max = 80) => (typeof value === "string" ? value.slice(0, max) : "");
const image = (value) => (typeof value === "string" && /^https:\/\/(?:coin-images|assets)\.coingecko\.com\//.test(value)
  ? value.slice(0, 300) : null);

const link = (value) => {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch { return null; }
};
const links = (values, max) => [...new Set((Array.isArray(values) ? values : []).map(link).filter(Boolean))].slice(0, max);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
// CoinGecko descriptions carry HTML links; the page shows them as plain text.
const plain = (value, max = 4000) => text(value, 20_000).replace(/<[^>]*>/g, "")
  .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name) => ENTITIES[name]).replace(/\r\n/g, "\n").trim().slice(0, max);
const handle = (value, pattern, prefix) => (typeof value === "string" && pattern.test(value) ? `${prefix}${value}` : null);

// Every 4th hourly point of the 7-day sparkline: enough for a small chart.
function sparkline(prices) {
  if (!Array.isArray(prices)) return [];
  return prices.filter((_, index) => index % 4 === 0 || index === prices.length - 1)
    .map(finite).filter((value) => value !== null).map((value) => Number(value.toPrecision(6)));
}

export function normalizeCoins(list) {
  if (!Array.isArray(list)) throw new Error("coin list is invalid");
  return list.slice(0, 100).map((coin) => ({
    id: text(coin?.id, 80), symbol: text(coin?.symbol, 20).toUpperCase(), name: text(coin?.name, 60),
    image: image(coin?.image), rank: finite(coin?.market_cap_rank), price: finite(coin?.current_price),
    change1h: finite(coin?.price_change_percentage_1h_in_currency),
    change24h: finite(coin?.price_change_percentage_24h_in_currency ?? coin?.price_change_percentage_24h),
    change7d: finite(coin?.price_change_percentage_7d_in_currency),
    marketCap: finite(coin?.market_cap), volume: finite(coin?.total_volume),
    circulating: finite(coin?.circulating_supply), maxSupply: finite(coin?.max_supply),
    sparkline: sparkline(coin?.sparkline_in_7d?.price),
  })).filter((coin) => coin.id && coin.symbol && coin.price !== null);
}

export function normalizeGlobal(value) {
  const data = value?.data;
  if (!data) throw new Error("global market data is invalid");
  return {
    marketCap: finite(data.total_market_cap?.usd), volume: finite(data.total_volume?.usd),
    marketCapChange24h: finite(data.market_cap_change_percentage_24h_usd),
    btcDominance: finite(data.market_cap_percentage?.btc), ethDominance: finite(data.market_cap_percentage?.eth),
    coins: finite(data.active_cryptocurrencies), exchanges: finite(data.markets),
  };
}

export function normalizeTrending(value) {
  const coins = value?.coins;
  if (!Array.isArray(coins)) throw new Error("trending data is invalid");
  return coins.slice(0, 15).map(({ item } = {}) => ({
    id: text(item?.id, 80), symbol: text(item?.symbol, 20).toUpperCase(), name: text(item?.name, 60),
    image: image(item?.small ?? item?.thumb), price: finite(item?.data?.price),
    change24h: finite(item?.data?.price_change_percentage_24h?.usd),
  })).filter((coin) => coin.id && coin.symbol);
}

// The index's history, oldest first, for the market overview page.
export function normalizeFearGreedHistory(value) {
  if (!Array.isArray(value?.data)) throw new Error("fear and greed history is invalid");
  return value.data.slice(0, 400).map((entry) => ({ value: Number(entry?.value), label: text(entry?.value_classification, 30),
    time: Number(entry?.timestamp) * 1000 }))
    .filter((entry) => Number.isInteger(entry.value) && entry.value >= 0 && entry.value <= 100 && Number.isFinite(entry.time))
    .reverse();
}

export function normalizeFearGreed(value) {
  const entry = value?.data?.[0];
  const score = Number(entry?.value);
  if (!Number.isInteger(score) || score < 0 || score > 100) throw new Error("fear and greed data is invalid");
  return { value: score, label: text(entry?.value_classification, 30) };
}

export const COIN_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
export const CHART_DAYS = new Set(["1", "7", "30", "90", "365"]);

export function normalizeCoin(coin) {
  if (!coin || typeof coin !== "object" || !text(coin.id)) throw new Error("coin data is invalid");
  const market = coin.market_data ?? {};
  const usd = (field) => finite(market[field]?.usd);
  const site = coin.links ?? {};
  const symbol = text(coin.symbol, 20).toUpperCase();
  const tickers = (Array.isArray(coin.tickers) ? coin.tickers : [])
    .filter((ticker) => !ticker?.is_stale && !ticker?.is_anomaly && text(ticker?.base, 13).length <= 12 &&
      text(ticker?.target, 13).length <= 12 && finite(ticker?.converted_volume?.usd) !== null)
    .sort((left, right) => right.converted_volume.usd - left.converted_volume.usd).slice(0, 12)
    .map((ticker) => ({
      market: text(ticker.market?.name, 40), exchange: text(ticker.market?.identifier, 40),
      base: text(ticker.base, 12), target: text(ticker.target, 12), price: finite(ticker.converted_last?.usd),
      volume: finite(ticker.converted_volume?.usd), url: link(ticker.trade_url),
      trust: ["green", "yellow", "red"].includes(ticker.trust_score) ? ticker.trust_score : null,
    }));
  return {
    id: text(coin.id), symbol, name: text(coin.name, 60), image: image(coin.image?.large ?? coin.image?.small),
    rank: finite(coin.market_cap_rank ?? market.market_cap_rank), price: usd("current_price"),
    change1h: finite(market.price_change_percentage_1h_in_currency?.usd),
    change24h: finite(market.price_change_percentage_24h_in_currency?.usd ?? market.price_change_percentage_24h),
    change7d: finite(market.price_change_percentage_7d_in_currency?.usd),
    change30d: finite(market.price_change_percentage_30d_in_currency?.usd),
    change1y: finite(market.price_change_percentage_1y_in_currency?.usd),
    marketCap: usd("market_cap"), fullyDiluted: usd("fully_diluted_valuation"), volume: usd("total_volume"),
    high24h: usd("high_24h"), low24h: usd("low_24h"), circulating: finite(market.circulating_supply),
    totalSupply: finite(market.total_supply), maxSupply: finite(market.max_supply),
    ath: usd("ath"), athChange: finite(market.ath_change_percentage?.usd), athDate: text(market.ath_date?.usd, 30),
    atl: usd("atl"), atlChange: finite(market.atl_change_percentage?.usd), atlDate: text(market.atl_date?.usd, 30),
    categories: (Array.isArray(coin.categories) ? coin.categories : []).map((name) => text(name, 60)).filter(Boolean).slice(0, 6),
    platforms: Object.entries(coin.platforms ?? {}).filter(([name, address]) => text(name) && text(address))
      .map(([name]) => text(name)).slice(0, 8),
    description: { en: plain(coin.description?.en), ru: plain(coin.description?.ru) },
    links: {
      websites: links(site.homepage, 3), whitepaper: link(site.whitepaper), explorers: links(site.blockchain_site, 6),
      source: links(site.repos_url?.github, 2), forums: links(site.official_forum_url, 2), chats: links(site.chat_url, 2),
      reddit: link(site.subreddit_url), x: handle(site.twitter_screen_name, /^[A-Za-z0-9_]{1,15}$/, "https://x.com/"),
      telegram: handle(site.telegram_channel_identifier, /^[A-Za-z0-9_]{3,64}$/, "https://t.me/"),
    },
    tickers, updatedAt: text(coin.last_updated, 30),
  };
}

// About 240 points draw a smooth chart at any width; the last point is always kept.
function thin(points) {
  if (!Array.isArray(points)) return [];
  const step = Math.max(1, Math.ceil(points.length / 240));
  return points.filter((_, index) => index % step === 0 || index === points.length - 1)
    .filter((point) => Array.isArray(point) && finite(point[0]) !== null && finite(point[1]) !== null)
    .map(([time, value]) => [time, Number(value.toPrecision(8))]);
}

export function normalizeChart(value) {
  if (!Array.isArray(value?.prices)) throw new Error("chart data is invalid");
  return { prices: thin(value.prices), caps: thin(value.market_caps), volumes: thin(value.total_volumes) };
}

// Search over every coin CoinGecko lists: name, symbol, rank and a thumbnail.
export function normalizeSearch(value) {
  if (!Array.isArray(value?.coins)) throw new Error("search data is invalid");
  return value.coins.slice(0, 20).map((coin) => ({
    id: text(coin?.id), symbol: text(coin?.symbol, 20).toUpperCase(), name: text(coin?.name, 60),
    rank: finite(coin?.market_cap_rank), image: image(coin?.large ?? coin?.thumb),
  })).filter((coin) => COIN_ID.test(coin.id) && coin.symbol);
}

// Coin pages and charts: fetched on demand, kept for ttl, shared by everyone
// asking at once, and limited to `perMinute` fetches. When the limit is spent
// a stale copy is served; with no copy at all the visitor is asked to retry.
function createOnDemand({ get, now, perMinute, maxEntries }) {
  const entries = new Map();
  const pending = new Map();
  let fetches = [];
  return async function lookup(key, url, normalize, ttlMs) {
    const entry = entries.get(key);
    if (entry && now() - entry.at < ttlMs) return entry;
    if (pending.has(key)) return pending.get(key);
    fetches = fetches.filter((at) => now() - at < 60_000);
    if (fetches.length >= perMinute) {
      if (entry) return entry;
      throw Object.assign(new Error("busy"), { status: 503 });
    }
    fetches.push(now());
    const job = (async () => {
      let fresh;
      try {
        fresh = { at: now(), value: normalize(await get(url)) };
      } catch (error) {
        if (error?.status === 404) fresh = { at: now(), missing: true };
        else if (entry) return entry;
        else throw error;
      }
      entries.delete(key);
      entries.set(key, fresh);
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return fresh;
    })();
    pending.set(key, job);
    try { return await job; } finally { pending.delete(key); }
  };
}

export function createMarketService({ fetch: get = fetchJson, refreshMs = 60_000, now = Date.now,
  coinFetchesPerMinute = 20, accounts = null, chain = null } = {}) {
  const state = { coins: [], global: null, trending: [], fearGreed: null, updatedAt: null, errors: {} };
  const sources = {
    coins: [`${COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1` +
      "&sparkline=true&price_change_percentage=1h,24h,7d", normalizeCoins],
    global: [`${COINGECKO}/global`, normalizeGlobal],
    trending: [`${COINGECKO}/search/trending`, normalizeTrending],
    fearGreed: [FEAR_GREED, normalizeFearGreed],
  };
  let timer = null;
  const onDemand = createOnDemand({ get, now, perMinute: coinFetchesPerMinute, maxEntries: 500 });

  // A source that fails keeps its last good value; the others still refresh.
  async function refresh() {
    await Promise.all(Object.entries(sources).map(async ([key, [url, normalize]]) => {
      try {
        state[key] = normalize(await get(url));
        delete state.errors[key];
      } catch (error) {
        state.errors[key] = String(error?.message ?? error).slice(0, 200);
      }
    }));
    if (state.coins.length) state.updatedAt = now();
    if (accounts?.checkAlerts && !state.errors.coins) await checkAlerts();
  }

  // Price alerts (market-alerts.mjs) are checked against the fresh prices; coins
  // outside the top hundred that an alert watches are priced in one more request.
  async function checkAlerts() {
    try {
      const prices = new Map(state.coins.map((coin) => [coin.id, coin]));
      const missing = accounts.alertCoins().filter((id) => !prices.has(id) && COIN_ID.test(id)).slice(0, 250);
      if (missing.length) {
        const list = await get(`${COINGECKO}/coins/markets?vs_currency=usd&ids=${missing.join(",")}&per_page=250` +
          "&price_change_percentage=24h");
        for (const coin of Array.isArray(list) ? list : []) {
          const quote = { price: finite(coin?.current_price),
            change24h: finite(coin?.price_change_percentage_24h_in_currency ?? coin?.price_change_percentage_24h) };
          if (typeof coin?.id === "string" && quote.price !== null) prices.set(coin.id, quote);
        }
      }
      await accounts.checkAlerts(prices);
      delete state.errors.alerts;
    } catch (error) {
      state.errors.alerts = String(error?.message ?? error).slice(0, 200);
    }
  }

  function overview() {
    const movers = state.coins.filter((coin) => coin.change24h !== null)
      .sort((left, right) => right.change24h - left.change24h);
    return {
      coins: state.coins, fearGreed: state.fearGreed, gainers: movers.slice(0, 5),
      global: state.global, losers: movers.slice(-5).reverse(), source: "CoinGecko",
      trending: state.trending, updatedAt: state.updatedAt,
    };
  }

  // GET /market/coins?page=N — pages after the first hundred coins, 100 a page, on demand.
  async function coinsPage(page) {
    if (page === 1) return state.coins;
    const entry = await onDemand(`coins:${page}`, `${COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc` +
      `&per_page=100&page=${page}&sparkline=true&price_change_percentage=1h,24h,7d`, normalizeCoins, 180_000);
    return entry.missing ? [] : entry.value;
  }

  // GET /market/search?q=… — queries are lower-cased and cached, so popular ones cost one fetch.
  async function search(query) {
    const needle = query.trim().toLowerCase().replace(/\s+/g, " ");
    if (!needle || needle.length > 40) return [];
    const entry = await onDemand(`search:${needle}`, `${COINGECKO}/search?query=${encodeURIComponent(needle)}`,
      normalizeSearch, 600_000);
    return entry.missing ? [] : entry.value;
  }

  // GET /market/coin/<id> and /market/chart/<id>?days=1|7|30|90|365
  async function coinData(kind, id, days) {
    if (!COIN_ID.test(id) || (kind === "chart" && !CHART_DAYS.has(days))) return null;
    const entry = kind === "coin"
      ? await onDemand(`coin:${id}`, `${COINGECKO}/coins/${id}?localization=true&tickers=true&market_data=true` +
        "&community_data=false&developer_data=false&sparkline=false", normalizeCoin, 120_000)
      : await onDemand(`chart:${id}:${days}`, `${COINGECKO}/coins/${id}/market_chart?vs_currency=usd&days=${days}`,
        normalizeChart, days === "1" ? 300_000 : 1_800_000);
    return entry.missing ? null : entry.value;
  }

  function send(response, status, body, maxAge = 30) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=${maxAge}` : "no-store", "access-control-allow-origin": "*" });
    response.end(JSON.stringify(body));
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    // Sign-in, profiles and server watchlists (blockchain/market-accounts.mjs).
    if (accounts && await accounts.handle(request, response, url)) return;
    // The on-chain explorer: transfers, addresses, search (blockchain/market-chain.mjs).
    if (chain && await chain.handle(request, response, url)) return;
    const [, kind, id] = /^\/market\/(coin|chart)\/([^/]+)$/.exec(url.pathname) ?? [];
    if (request.method === "GET" && url.pathname === "/market/coins") {
      const page = Number(url.searchParams.get("page") ?? 1);
      if (!Number.isInteger(page) || page < 1 || page > 500) return send(response, 404, { error: "no such page" });
      try {
        send(response, 200, { page, coins: await coinsPage(page), total: state.global?.coins ?? null }, 60);
      } catch {
        send(response, 503, { error: "coins are unavailable, try again in a minute" });
      }
    } else if (request.method === "GET" && url.pathname === "/market/fear-greed") {
      try {
        const entry = await onDemand("fear-greed", "https://api.alternative.me/fng/?limit=365", normalizeFearGreedHistory, 3_600_000);
        send(response, 200, { history: entry.missing ? [] : entry.value }, 600);
      } catch {
        send(response, 503, { error: "the index is unavailable, try again in a minute" });
      }
    } else if (request.method === "GET" && url.pathname === "/market/search") {
      try {
        send(response, 200, { coins: await search(url.searchParams.get("q") ?? "") }, 300);
      } catch {
        send(response, 503, { error: "search is unavailable, try again in a minute" });
      }
    } else if (request.method === "GET" && url.pathname === "/market/overview") {
      const ready = state.updatedAt !== null;
      send(response, ready ? 200 : 503, ready ? overview() : { error: "market data is loading" });
    } else if (request.method === "GET" && kind) {
      try {
        const value = await coinData(kind, id, url.searchParams.get("days"));
        if (value) send(response, 200, value, 60);
        else send(response, 404, { error: "unknown coin" });
      } catch {
        send(response, 503, { error: "coin data is unavailable, try again in a minute" });
      }
    } else {
      send(response, 404, { error: "not found" });
    }
  });
  server.on("close", () => clearInterval(timer));

  return {
    server, refresh, overview, state,
    start() {
      void refresh();
      timer = setInterval(() => { void refresh(); }, refreshMs);
      timer.unref?.();
    },
  };
}
