#!/usr/bin/env node
// npm run market:serve -- [port] — NIR Markets data for nircoin.com
// (blockchain/market-service.mjs). Caddy passes /market/* to it.
// --fixture <directory> serves recorded responses instead (for checks).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { createAccounts } from "./market-accounts.mjs";
import { createChain, fetchExplorer } from "./market-chain.mjs";
import { createOpenSea } from "./market-opensea.mjs";
import { createScreener } from "./market-screener.mjs";
import { createLedger } from "./market-ledger.mjs";
import { createBehaviour } from "./market-behaviour.mjs";
import { createDensities } from "./market-densities.mjs";
import { createBook, createDeep } from "./market-book.mjs";
import { createPatoshi } from "./market-patoshi.mjs";
import { createLiquidations } from "./market-liquidations.mjs";
import { createLogos } from "./market-logos.mjs";
import { createMarketService } from "./market-service.mjs";
import { createPrices } from "./market-prices.mjs";
import { createMasks } from "./market-masks.mjs";

const args = process.argv.slice(2);
const fixtureAt = args.indexOf("--fixture");
const fixture = fixtureAt >= 0 ? args.splice(fixtureAt, 2)[1] : null;
const port = Number(args[0] ?? 8790);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  console.error("usage: market:serve -- [port] [--fixture <directory>]");
  process.exit(2);
}
const files = { "coins/markets": "coins.json", "/global": "global.json", "search/trending": "trending.json", "fng": "fng.json",
  "/search?": "search.json" };
// A coin's page and chart come from coin-<id>.json and chart-<id>.json; other coins are unknown.
function fixtureFile(url) {
  const coin = /\/coins\/([^/?]+)(\/market_chart)?/.exec(url);
  if (coin && coin[1] !== "markets") return `${coin[2] ? "chart" : "coin"}-${coin[1]}.json`;
  return Object.entries(files).find(([key]) => url.includes(key))[1];
}
// Accounts need a database file (NIR_MARKET_DB); Google sign-in also needs
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, from /etc/nir-market.env on the server;
// NIR_MARKET_ADMINS lists the Google emails of comment moderators.
const env = process.env;
const accounts = env.NIR_MARKET_DB ? createAccounts({ file: env.NIR_MARKET_DB, clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET, admins: (env.NIR_MARKET_ADMINS ?? "").split(","), publicUrl: env.NIR_MARKET_PUBLIC_URL ?? `http://localhost:${port}` }) : null;
// The explorer always reads the live public explorers; prices for the UTXO network come from the overview.
// NIR Markets' own book of wallet names lives beside the accounts database (names.db), or in memory.
const namesFile = env.NIR_MARKET_DB ? join(dirname(env.NIR_MARKET_DB), "names.db") : ":memory:";
// Token pictures are kept beside it too (logos/), fetched once each (market-logos.mjs). The assets
// catalogue names its folders after the networks; the main network's comes from CoinGecko by chain id.
const catalogue = { optimism: "optimism", base: "base", arbitrum: "arbitrum", polygon: "polygon", bsc: "smartchain" };
const logos = env.NIR_MARKET_DB ? createLogos({ dir: join(dirname(env.NIR_MARKET_DB), "logos"),
  catalogue: (network) => catalogue[network] ?? (network === "eth" ? chain.platform(1) : null) }) : null;
const ledger = createLedger({ file: env.NIR_MARKET_DB ? join(dirname(env.NIR_MARKET_DB), "transfers.db") : ":memory:" });
// Known wallets go out under ids, their addresses kept here (market-masks.mjs); the hand-picked ones and
// their readable ids come from data/featured-wallets.json.
const featured = (() => { try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "data", "featured-wallets.json"), "utf8")); } catch { return {}; } })();
const masks = createMasks({ file: env.NIR_MARKET_DB ? join(dirname(env.NIR_MARKET_DB), "masks.db") : ":memory:", featured });
const chain = createChain({ masks, nativePrice: (symbol) => service.state.coins.find((coin) => coin.symbol === symbol)?.price ?? null,
  labelFor: (address) => accounts?.labelFor(address) ?? null, namesFile, logos,
  // OpenSea profiles when OPENSEA_API_KEY is set in /etc/nir-market.env (market-opensea.mjs).
  opensea: createOpenSea({ key: env.OPENSEA_API_KEY, get: fetchExplorer }),
  // NIR Markets' own store of wallet transfers (transfers.db), read back for the bubbles (market-ledger.mjs).
  // Satoshi Nakamoto's early coins, read key by key into patoshi.db (market-patoshi.mjs).
  patoshi: fixture ? null : createPatoshi({ get: fetchExplorer, file: env.NIR_MARKET_DB ? join(dirname(env.NIR_MARKET_DB), "patoshi.db") : ":memory:",
    getText: async (url) => { const response = await fetch(url, { signal: AbortSignal.timeout(60_000) }); if (!response.ok) throw new Error(`list answered ${response.status}`); return response.text(); } }),
  ledger });
// The trend screener reads the exchanges' public futures tickers once a minute.
// The screener keeps its price snapshots next to the accounts, so a restart does not empty the short-term columns.
const screener = fixture ? null : createScreener({ get: fetchExplorer, coinOf: (symbol) => chain.coinOfSymbol(symbol), file: env.NIR_MARKET_DB ? join(dirname(env.NIR_MARKET_DB), "screener.json") : null,
  read: (path) => readFileSync(path, "utf8"), write: (path, text) => writeFileSync(path, text) });
// The density screener reads the exchanges' futures order books, the screener's busiest coins first.
// The order book screener reads a pair's book, trades and candles when a visitor asks (shared, two seconds).
// Binance's books in full depth come from its stream of changes, kept for the pairs being looked at.
const book = fixture ? null : createBook({ get: fetchExplorer, deep: createDeep({ get: fetchExplorer }) });
const densities = fixture ? null : createDensities({ get: fetchExplorer, coinOf: (symbol) => chain.coinOfSymbol(symbol),
  coins: () => screener?.snapshot().rows ?? [] });
// Liquidations on Binance, Bybit and OKX, kept a day (liquidations.json beside the accounts).
const liquidations = fixture ? null : createLiquidations({ get: fetchExplorer, coinOf: (symbol) => chain.coinOfSymbol(symbol),
  coins: () => screener?.snapshot().rows ?? [], file: env.NIR_MARKET_DB ? join(dirname(env.NIR_MARKET_DB), "liquidations.json") : null,
  read: (path) => readFileSync(path, "utf8"), write: (path, text) => writeFileSync(path, text) });
const service = createMarketService(fixture ? {
  accounts, chain,
  fetch: async (url) => {
    try {
      return JSON.parse(readFileSync(join(fixture, fixtureFile(url)), "utf8"));
    } catch (error) {
      throw error?.code === "ENOENT" ? Object.assign(new Error("not found"), { status: 404 }) : error;
    }
  },
} : { accounts, chain, screener, densities, liquidations, book, cacheFile: env.NIR_MARKET_DB ? join(dirname(env.NIR_MARKET_DB), "cache.db") : null,
  // The exchanges' own spot prices over CoinGecko's, every 20 seconds (market-prices.mjs).
  prices: createPrices({ get: fetchExplorer }),
  // The coin page's HTML, for the copy with the coin's name and price in it (market-seo.mjs).
  coinTemplate: () => { try { return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "site", "coin", "index.html"), "utf8"); } catch { return null; } } });
service.server.listen(port, "127.0.0.1", () => console.log(`NIR Markets data on 127.0.0.1:${port}`));
service.start();
chain.warm();
screener?.start();
densities?.start();
book?.start(() => (screener?.snapshot().rows ?? []).map((row) => row.symbol));
liquidations?.start();
// The market list's coin pictures kept on this server ahead of the visitors (market-logos.mjs), every ten minutes.
if (logos && !fixture) {
  const warmLogos = () => void logos.warmCoins([...service.state.coins, ...service.state.trendingCoins].map((coin) => coin.image));
  setTimeout(warmLogos, 30_000).unref?.();
  setInterval(warmLogos, 10 * 60_000).unref?.();
}
chain.patoshi?.start();
if (!fixture) chain.names.start(); // the group lists of the open labels, copied into the book a page at a time
// Every hour, names from the wallets' behaviour in the store of transfers (deposit addresses, hot wallets).
if (!fixture) createBehaviour({ ledger, names: chain.names }).start();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => service.server.close(() => process.exit(0)));
