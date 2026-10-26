#!/usr/bin/env node
// npm run market:serve -- [port] — NIR Markets data for nircoin.com
// (blockchain/market-service.mjs). Caddy passes /market/* to it.
// --fixture <directory> serves recorded responses instead (for checks).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import { createAccounts } from "./market-accounts.mjs";
import { createChain } from "./market-chain.mjs";
import { createLogos } from "./market-logos.mjs";
import { createMarketService } from "./market-service.mjs";

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
const chain = createChain({ nativePrice: (symbol) => service.state.coins.find((coin) => coin.symbol === symbol)?.price ?? null,
  labelFor: (address) => accounts?.labelFor(address) ?? null, namesFile, logos });
const service = createMarketService(fixture ? {
  accounts, chain,
  fetch: async (url) => {
    try {
      return JSON.parse(readFileSync(join(fixture, fixtureFile(url)), "utf8"));
    } catch (error) {
      throw error?.code === "ENOENT" ? Object.assign(new Error("not found"), { status: 404 }) : error;
    }
  },
} : { accounts, chain });
service.server.listen(port, "127.0.0.1", () => console.log(`NIR Markets data on 127.0.0.1:${port}`));
service.start();
chain.warm();
if (!fixture) chain.names.start(); // the group lists of the open labels, copied into the book a page at a time
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => service.server.close(() => process.exit(0)));
