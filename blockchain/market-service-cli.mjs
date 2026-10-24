#!/usr/bin/env node
// npm run market:serve -- [port] — NIR Markets data for nircoin.com
// (blockchain/market-service.mjs). Caddy passes /market/* to it.
// --fixture <directory> serves recorded responses instead (for checks).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { createAccounts } from "./market-accounts.mjs";
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
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, from /etc/nir-market.env on the server.
const env = process.env;
const accounts = env.NIR_MARKET_DB ? createAccounts({ file: env.NIR_MARKET_DB, clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET, publicUrl: env.NIR_MARKET_PUBLIC_URL ?? `http://localhost:${port}` }) : null;
const service = createMarketService(fixture ? {
  accounts,
  fetch: async (url) => {
    try {
      return JSON.parse(readFileSync(join(fixture, fixtureFile(url)), "utf8"));
    } catch (error) {
      throw error?.code === "ENOENT" ? Object.assign(new Error("not found"), { status: 404 }) : error;
    }
  },
} : { accounts });
service.server.listen(port, "127.0.0.1", () => console.log(`NIR Markets data on 127.0.0.1:${port}`));
service.start();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => service.server.close(() => process.exit(0)));
