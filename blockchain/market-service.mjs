// NIR Markets (nircoin.com): prices of the top 100 coins, the whole market,
// what is trending and the Fear & Greed index. The server fetches them once a
// minute and serves every visitor from that copy, so the free data sources
// see one client however many people open the page.
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
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error("market response is too large");
  return JSON.parse(text);
}

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value, max = 80) => (typeof value === "string" ? value.slice(0, max) : "");
const image = (value) => (typeof value === "string" && /^https:\/\/(?:coin-images|assets)\.coingecko\.com\//.test(value)
  ? value.slice(0, 300) : null);

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
    coins: finite(data.active_cryptocurrencies),
  };
}

export function normalizeTrending(value) {
  const coins = value?.coins;
  if (!Array.isArray(coins)) throw new Error("trending data is invalid");
  return coins.slice(0, 7).map(({ item } = {}) => ({
    id: text(item?.id, 80), symbol: text(item?.symbol, 20).toUpperCase(), name: text(item?.name, 60),
    image: image(item?.small ?? item?.thumb), price: finite(item?.data?.price),
    change24h: finite(item?.data?.price_change_percentage_24h?.usd),
  })).filter((coin) => coin.id && coin.symbol);
}

export function normalizeFearGreed(value) {
  const entry = value?.data?.[0];
  const score = Number(entry?.value);
  if (!Number.isInteger(score) || score < 0 || score > 100) throw new Error("fear and greed data is invalid");
  return { value: score, label: text(entry?.value_classification, 30) };
}

export function createMarketService({ fetch: get = fetchJson, refreshMs = 60_000, now = Date.now } = {}) {
  const state = { coins: [], global: null, trending: [], fearGreed: null, updatedAt: null, errors: {} };
  const sources = {
    coins: [`${COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1` +
      "&sparkline=true&price_change_percentage=1h,24h,7d", normalizeCoins],
    global: [`${COINGECKO}/global`, normalizeGlobal],
    trending: [`${COINGECKO}/search/trending`, normalizeTrending],
    fearGreed: [FEAR_GREED, normalizeFearGreed],
  };
  let timer = null;

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

  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (request.method !== "GET" || path !== "/market/overview") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not found"}');
      return;
    }
    const ready = state.updatedAt !== null;
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=30", "access-control-allow-origin": "*" });
    response.end(JSON.stringify(ready ? overview() : { error: "market data is loading" }));
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
