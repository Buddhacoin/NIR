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
// Trending coins outside the top hundred get their full market rows in one
// more request, and the community's rise votes on CoinGecko (the share of
// "good" votes over a day) are read for one coin every twenty seconds and
// kept a day, so the sentiment column is filled where NIR Markets' own votes
// are still few.
//
// Sources: CoinGecko (prices, market, trending; credited on the page) and
// alternative.me (Fear & Greed). COINGECKO_API_KEY adds a free demo key.
import { createServer } from "node:http";

import { createTrades } from "./market-trades.mjs";

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

// A change CoinGecko leaves out (young or thinly traded coins) is read off the
// hourly 7-day prices instead: the price now against an hour, a day or a week back.
function changeFrom(prices, hoursBack) {
  const list = Array.isArray(prices) ? prices.filter((value) => finite(value) !== null) : [];
  // A coin younger than the span gets no figure rather than a shorter one.
  if (list.length < 2 || list.length < hoursBack) return null;
  const then = list[Math.max(0, list.length - 1 - hoursBack)];
  return then > 0 ? Number(((list.at(-1) / then - 1) * 100).toFixed(2)) : null;
}

export function normalizeCoins(list) {
  if (!Array.isArray(list)) throw new Error("coin list is invalid");
  return list.slice(0, 100).map((coin) => ({
    id: text(coin?.id, 80), symbol: text(coin?.symbol, 20).toUpperCase(), name: text(coin?.name, 60),
    image: image(coin?.image), rank: finite(coin?.market_cap_rank), price: finite(coin?.current_price),
    change1h: finite(coin?.price_change_percentage_1h_in_currency) ?? changeFrom(coin?.sparkline_in_7d?.price, 1),
    change24h: finite(coin?.price_change_percentage_24h_in_currency ?? coin?.price_change_percentage_24h) ?? changeFrom(coin?.sparkline_in_7d?.price, 24),
    change7d: finite(coin?.price_change_percentage_7d_in_currency) ?? changeFrom(coin?.sparkline_in_7d?.price, 168),
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

// Trending tokens that borrow a large coin's ticker (a meme "BTC" at two cents) are left out of
// the lists, so they are never taken for the real coin.
export function withoutLookalikes(trending, coins) {
  const owners = new Map(coins.slice(0, 50).map((coin) => [coin.symbol, coin.id]));
  return trending.filter((coin) => (owners.get(coin.symbol) ?? coin.id) === coin.id);
}

// Exchange logos by CoinGecko id, for the "where it trades" table (one list a day).
export function normalizeExchangeLogos(list) {
  if (!Array.isArray(list)) throw new Error("exchange list is invalid");
  return Object.fromEntries(list.map((item) => [text(item?.id, 40), image(item?.image)]).filter(([id, logo]) => id && logo));
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
    contracts: Object.fromEntries(Object.entries(coin.platforms ?? {}).filter(([name, address]) => text(name) && /^[A-Za-z0-9]{20,64}$/.test(text(address, 70)))
      .slice(0, 12).map(([name, address]) => [text(name, 40), text(address, 70)])),
    description: { en: plain(coin.description?.en), ru: plain(coin.description?.ru) },
    links: {
      websites: links(site.homepage, 3), whitepaper: link(site.whitepaper), explorers: links(site.blockchain_site, 6),
      source: links(site.repos_url?.github, 2), forums: links(site.official_forum_url, 2), chats: links(site.chat_url, 2),
      reddit: link(site.subreddit_url), x: handle(site.twitter_screen_name, /^[A-Za-z0-9_]{1,15}$/, "https://x.com/"),
      telegram: handle(site.telegram_channel_identifier, /^[A-Za-z0-9_]{3,64}$/, "https://t.me/"),
    },
    tickers, updatedAt: text(coin.last_updated, 30), sentimentUp: finite(coin.sentiment_votes_up_percentage),
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
// `blocked()`: while true (CoinGecko asked to slow down) nothing new is fetched; copies are served.
function createOnDemand({ get, now, perMinute, maxEntries, blocked = () => false }) {
  const entries = new Map();
  const pending = new Map();
  let fetches = [];
  // An expired copy is served at once while a fresh one is fetched behind it, so a page never waits
  // for the data source on a coin it has seen before.
  return async function lookup(key, url, normalize, ttlMs) {
    const entry = entries.get(key);
    if (entry && now() - entry.at < ttlMs) return entry;
    if (entry && !entry.missing) {
      if (!pending.has(key)) void fetchEntry(key, url, normalize, entry, ttlMs).catch(() => {});
      return entry;
    }
    return fetchEntry(key, url, normalize, entry, ttlMs);
  };
  async function fetchEntry(key, url, normalize, entry, ttlMs) {
    if (pending.has(key)) return pending.get(key);
    fetches = fetches.filter((at) => now() - at < 60_000);
    if (fetches.length >= perMinute || blocked()) {
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
        else if (entry) {
          // The old copy stays and is tried again in a minute, not on every request.
          entry.at = Math.max(entry.at, now() - ttlMs + 60_000);
          return entry;
        } else throw error;
      }
      entries.delete(key);
      entries.set(key, fresh);
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return fresh;
    })();
    pending.set(key, job);
    try { return await job; } finally { pending.delete(key); }
  }
}

export function createMarketService({ fetch: get = fetchJson, refreshMs = 60_000, now = Date.now,
  coinFetchesPerMinute = 20, accounts = null, chain = null, communityMs = 45_000, trades = createTrades({ get, now }), screener = null } = {}) {
  const state = { coins: [], global: null, trending: [], trendingCoins: [], fearGreed: null, updatedAt: null, errors: {} };
  const community = new Map(); // coin id → { up: percent of rise votes or null, at }
  const sources = {
    coins: [`${COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1` +
      "&sparkline=true&price_change_percentage=1h,24h,7d", normalizeCoins],
    global: [`${COINGECKO}/global`, normalizeGlobal, 180_000],
    trending: [`${COINGECKO}/search/trending`, normalizeTrending, 300_000],
    fearGreed: [FEAR_GREED, normalizeFearGreed, 600_000],
  };
  // The prices refresh every minute; the slower figures less often, to spare CoinGecko's free limit
  // for visitors' coin pages. A source that failed is tried again on the next refresh.
  const fetchedAt = {};
  let timer = null;
  // CoinGecko's free plan allows a handful of requests a minute. A "too many" answer pauses the
  // background work (votes, warming coin pages) for two minutes, so visitors' pages get the room.
  let coolUntil = 0;
  // Visitors' pages wait out a refusal for half a minute only, and a refusal to the background work
  // does not hold them up at all.
  let pageCoolUntil = 0;
  const cg = async (url) => {
    try {
      return await get(url);
    } catch (error) {
      if (error?.status === 429) coolUntil = now() + 120_000;
      throw error;
    }
  };
  const cgPage = async (url) => {
    try {
      return await get(url);
    } catch (error) {
      if (error?.status === 429) pageCoolUntil = now() + 30_000;
      throw error;
    }
  };
  const onDemand = createOnDemand({ get: cgPage, now, perMinute: coinFetchesPerMinute, maxEntries: 500, blocked: () => now() < pageCoolUntil });
  // Sources other than CoinGecko (the Fear & Greed history) have their own small budget.
  const onOther = createOnDemand({ get, now, perMinute: 10, maxEntries: 20 });
  // Search has a smaller budget of its own, so typing visitors cannot use up the coin pages' room.
  const onSearch = createOnDemand({ get: cgPage, now, perMinute: 6, maxEntries: 300, blocked: () => now() < pageCoolUntil });
  const coinUrl = (id) => `${COINGECKO}/coins/${id}?localization=true&tickers=true&market_data=true` +
    "&community_data=false&developer_data=false&sparkline=false";

  // A source that fails keeps its last good value; the others still refresh.
  // One refresh at a time: a slow one never overlaps the next.
  let refreshing = null;
  function refresh() {
    refreshing ??= refreshOnce().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function refreshOnce() {
    await Promise.all(Object.entries(sources).map(async ([key, [url, normalize, every = 0]]) => {
      if (fetchedAt[key] && now() - fetchedAt[key] < every && !state.errors[key]) return;
      try {
        state[key] = normalize(await cg(url));
        fetchedAt[key] = now();
        delete state.errors[key];
      } catch (error) {
        state.errors[key] = String(error?.message ?? error).slice(0, 200);
      }
    }));
    if (state.coins.length) state.updatedAt = now();
    await trendingRows();
    await refreshExchangeLogos();
    if (accounts?.checkAlerts && !state.errors.coins) await checkAlerts();
  }

  // Exchange logos, one list a day; a failed fetch keeps the last list and tries again ten minutes later.
  let exchangeLogos = {};
  let exchangeLogosAt = 0;
  async function refreshExchangeLogos() {
    if (now() - exchangeLogosAt < 86_400_000) return;
    try {
      if (now() < coolUntil) return;
      exchangeLogos = normalizeExchangeLogos(await cg(`${COINGECKO}/exchanges?per_page=250&page=1`));
      exchangeLogosAt = now();
      delete state.errors.exchangeLogos;
    } catch (error) {
      // Tried again in ten minutes, not on every refresh.
      exchangeLogosAt = now() - 86_400_000 + 600_000;
      state.errors.exchangeLogos = String(error?.message ?? error).slice(0, 200);
    }
  }

  // Trending coins outside the top hundred: their full rows (1h and 7d change, cap, volume, supply, sparkline).
  let trendingAsked = "";
  let trendingAt = 0;
  async function trendingRows() {
    const top = new Set(state.coins.map((coin) => coin.id));
    const ids = state.trending.map((coin) => coin.id).filter((id) => !top.has(id) && COIN_ID.test(id));
    const key = ids.join(",");
    if (!ids.length) { state.trendingCoins = []; return; }
    if (key === trendingAsked && now() - trendingAt < 300_000) return;
    try {
      if (now() < coolUntil) return;
      state.trendingCoins = normalizeCoins(await cg(`${COINGECKO}/coins/markets?vs_currency=usd&ids=${key}&per_page=50` +
        "&sparkline=true&price_change_percentage=1h,24h,7d"));
      trendingAsked = key;
      trendingAt = now();
      delete state.errors.trendingCoins;
    } catch (error) {
      state.errors.trendingCoins = String(error?.message ?? error).slice(0, 200);
    }
  }

  // In the background, one coin at a time (the top hundred and the trending ones, the stalest
  // first): its page data is fetched ahead of visitors, and its community votes come with it.
  // Paused while CoinGecko asks to slow down.
  async function communityTick() {
    if (now() < coolUntil) return;
    const ids = [...state.coins.map((coin) => coin.id), ...state.trending.map((coin) => coin.id)].filter((id) => COIN_ID.test(id));
    const next = ids.find((id) => !community.has(id)) ?? ids.filter((id) => now() - community.get(id).at > 6 * 3_600_000)
      .sort((left, right) => community.get(left).at - community.get(right).at)[0];
    if (!next) return;
    try {
      const entry = await onDemand(`coin:${next}`, coinUrl(next), normalizeCoin, 120_000);
      community.set(next, { up: entry.missing ? null : entry.value.sentimentUp, at: now() });
      if (community.size > 400) community.delete(community.keys().next().value);
    } catch {}
  }

  // Price alerts (market-alerts.mjs) are checked against the fresh prices; coins
  // outside the top hundred that an alert watches are priced in one more request.
  async function checkAlerts() {
    try {
      const prices = new Map(state.coins.map((coin) => [coin.id, coin]));
      const missing = accounts.alertCoins().filter((id) => !prices.has(id) && COIN_ID.test(id)).slice(0, 250);
      if (missing.length) {
        const list = await cg(`${COINGECKO}/coins/markets?vs_currency=usd&ids=${missing.join(",")}&per_page=250` +
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
      trending: withoutLookalikes(state.trending, state.coins), trendingCoins: withoutLookalikes(state.trendingCoins, state.coins),
      updatedAt: state.updatedAt,
      community: Object.fromEntries([...community].filter(([, entry]) => entry.up !== null).map(([id, entry]) => [id, entry.up])),
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
    if (needle.length < 2 || needle.length > 40) return [];
    const entry = await onSearch(`search:${needle}`, `${COINGECKO}/search?query=${encodeURIComponent(needle)}`,
      normalizeSearch, 600_000);
    return entry.missing ? [] : entry.value;
  }

  // GET /market/coin/<id> and /market/chart/<id>?days=1|7|30|90|365
  async function coinData(kind, id, days) {
    if (!COIN_ID.test(id) || (kind === "chart" && !CHART_DAYS.has(days))) return null;
    let entry;
    const row = [...state.coins, ...state.trendingCoins].find((coin) => coin.id === id);
    const stand = () => (kind === "coin" ? partialCoin(row) : weekChart(row));
    try {
      const fetching = kind === "coin"
        ? onDemand(`coin:${id}`, coinUrl(id), normalizeCoin, 120_000)
        : onDemand(`chart:${id}:${days}`, `${COINGECKO}/coins/${id}/market_chart?vs_currency=usd&days=${days}`,
          normalizeChart, days === "1" ? 300_000 : 1_800_000);
      // A coin in the market list never waits long on a slow source: after 2.5 seconds the page gets
      // the list's figures, and the fetch finishes behind it for the next ask.
      entry = row ? await Promise.race([fetching, new Promise((resolve) => { setTimeout(resolve, 2_500, null).unref?.(); })]) : await fetching;
      if (!entry) { fetching.catch(() => {}); return stand(); }
    } catch (error) {
      // CoinGecko is busy and the coin was never fetched: the page opens from the market list
      // (price, changes, cap, supply, the week's prices) and asks again for the rest.
      if (!row) throw error;
      return stand();
    }
    if (entry.missing) return null;
    if (kind !== "coin") return entry.value;
    if (entry.value.sentimentUp !== null) community.set(id, { up: entry.value.sentimentUp, at: now() });
    // The markets table shows each exchange's logo; without the list the names stand alone.
    return { ...entry.value, tickers: entry.value.tickers.map((ticker) => ({ ...ticker, logo: exchangeLogos[ticker.exchange] ?? null })) };
  }
  function partialCoin(row) {
    // The coin's contracts come from the coin list the explorer keeps, so its trades can show while the rest waits.
    const known = Object.entries(chain?.platformsOf?.(row.id) ?? {}).filter(([name, address]) => /^[a-z0-9-]{2,40}$/.test(name) && /^[A-Za-z0-9]{20,64}$/.test(String(address ?? "")));
    return { ...row, partial: true, change30d: null, change1y: null, fullyDiluted: null, high24h: null, low24h: null, totalSupply: null,
      ath: null, athChange: null, athDate: "", atl: null, atlChange: null, atlDate: "", categories: [], platforms: known.map(([name]) => name).slice(0, 8),
      contracts: Object.fromEntries(known.slice(0, 12)),
      description: { en: "", ru: "" }, tickers: [], updatedAt: "", sentimentUp: null,
      links: { websites: [], whitepaper: null, explorers: [], source: [], forums: [], chats: [], reddit: null, x: null, telegram: null } };
  }
  // The week's prices from the market list, spread evenly over seven days, while the real chart waits
  // (for any period: the page says it shows the week).
  function weekChart(row) {
    if (row.sparkline.length < 2) throw Object.assign(new Error("busy"), { status: 503 });
    const step = 7 * 86_400_000 / (row.sparkline.length - 1);
    const start = now() - 7 * 86_400_000;
    return { prices: row.sparkline.map((value, index) => [Math.round(start + index * step), value]), caps: [], volumes: [], partial: true, days: 7 };
  }

  function send(response, status, body, maxAge = 30) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=${maxAge}` : "no-store", "access-control-allow-origin": "*" });
    response.end(JSON.stringify(body));
  }

  // An error in a handler answers 500 instead of stopping the service (and losing every cache).
  const server = createServer((request, response) => {
    handleRequest(request, response).catch(() => {
      if (!response.headersSent) send(response, 500, { error: "something went wrong" });
      else response.destroy();
    });
  });
  async function handleRequest(request, response) {
    const url = new URL(request.url, "http://localhost");
    // Sign-in, profiles and server watchlists (blockchain/market-accounts.mjs).
    if (accounts && await accounts.handle(request, response, url)) return;
    // The on-chain explorer: transfers, addresses, search (blockchain/market-chain.mjs).
    if (chain && await chain.handle(request, response, url)) return;
    // Live trades in a coin's busiest exchange pool (blockchain/market-trades.mjs).
    if (await trades.handle(request, response, url)) return;
    // The trend screener over the exchanges' futures markets (blockchain/market-screener.mjs).
    if (screener && await screener.handle(request, response, url)) return;
    const [, kind, id] = /^\/market\/(coin|chart)\/([^/]+)$/.exec(url.pathname) ?? [];
    // GET /market/coins?ids=a,b,… — chosen coins' rows (a watchlist beyond the top hundred), 50 at most.
    if (request.method === "GET" && url.pathname === "/market/coins" && url.searchParams.has("ids")) {
      const ids = [...new Set((url.searchParams.get("ids") ?? "").split(",").filter((id) => COIN_ID.test(id)))].sort().slice(0, 50);
      if (!ids.length) return send(response, 200, { coins: [] }, 60);
      try {
        const entry = await onDemand(`ids:${ids.join(",")}`, `${COINGECKO}/coins/markets?vs_currency=usd&ids=${ids.join(",")}&per_page=50` +
          "&sparkline=true&price_change_percentage=1h,24h,7d", normalizeCoins, 120_000);
        send(response, 200, { coins: entry.missing ? [] : entry.value }, 60);
      } catch {
        send(response, 503, { error: "coins are unavailable, try again in a minute" });
      }
    } else if (request.method === "GET" && url.pathname === "/market/coins") {
      const page = Number(url.searchParams.get("page") ?? 1);
      if (!Number.isInteger(page) || page < 1 || page > 500) return send(response, 404, { error: "no such page" });
      try {
        send(response, 200, { page, coins: await coinsPage(page), total: state.global?.coins ?? null }, 60);
      } catch {
        send(response, 503, { error: "coins are unavailable, try again in a minute" });
      }
    } else if (request.method === "GET" && url.pathname === "/market/fear-greed") {
      try {
        const entry = await onOther("fear-greed", "https://api.alternative.me/fng/?limit=365", normalizeFearGreedHistory, 3_600_000);
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
        if (value) send(response, 200, value, value.partial ? 0 : 60);
        else send(response, 404, { error: "unknown coin" });
      } catch {
        send(response, 503, { error: "coin data is unavailable, try again in a minute" });
      }
    } else {
      send(response, 404, { error: "not found" });
    }
  }
  let communityTimer = null;
  server.on("close", () => { clearInterval(timer); clearInterval(communityTimer); });

  return {
    server, refresh, overview, state, communityTick,
    start() {
      void refresh();
      timer = setInterval(() => { void refresh(); }, refreshMs);
      timer.unref?.();
      communityTimer = setInterval(() => { void communityTick(); }, communityMs);
      communityTimer.unref?.();
    },
  };
}
