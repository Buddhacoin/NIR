# NIR Markets (nircoin.com)

The home page of nircoin.com is **NIR Markets**: prices of the 100 largest
coins, the whole market, what is trending, top gainers, the Fear & Greed index
and a short market summary, in Russian and English, with day and night
themes. It is useful to traders who know nothing about NIR yet; the NIR logo
leads to the NIR page at `/nir/`, and a strip on top shows NIR's own network
(miners, pioneers, NIR mined) with a button to start mining.

## Data

`blockchain/market-service.mjs` runs on the website's server
(`nir-market.service`, `127.0.0.1:8790`, `npm run market:serve`). Once a
minute it fetches:

- CoinGecko: `/coins/markets` (top 100 with 1h/24h/7d changes and 7-day
  sparklines), `/global` and `/search/trending`;
- alternative.me: the Fear & Greed index.

It serves every visitor from that copy at `GET /market/overview` (Caddy passes
`/market/*` to it), so the free sources see one client however many people
visit. A source that fails keeps its last good data. A free CoinGecko demo key
can be set as `COINGECKO_API_KEY` in `/etc/nir-market.env`. The page credits
CoinGecko for prices and TradingView for charts.

Charts are TradingView's free embedded widget (the coin's main Binance pair), opened
under a coin's row; stablecoins have none. The market summary is assembled from
the prices; an AI-written brief and a per-coin "Why is it moving?" come next.

The watchlist, theme and language stay in the visitor's browser; the page
needs no account and loads no trackers.
