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

## A coin's page

Every coin has its own page at `/coin/<id>` (the CoinGecko id, e.g.
`/coin/zeus-token`); a row in the table, a trending coin or a top gainer opens
it. It shows the price with 1h/24h/7d changes and the 24h range, market cap,
volume, fully diluted value, supply, all-time high and low, links (website,
whitepaper, source, block explorers, well-known wallets, community), a
converter, a price chart for 1 day to 1 year with volume bars (TradingView
candles for coins with a Binance pair), the description (Russian when
CoinGecko has it) and the markets where the coin trades.

The page asks the market service for `GET /market/coin/<id>` and
`GET /market/chart/<id>?days=1|7|30|90|365`. Those are fetched only when
someone opens the page: a coin is kept for 2 minutes, a chart for 5 to 30
minutes, visitors asking for the same coin at once share one fetch, and no
more than 20 such fetches go to CoinGecko a minute. Past that limit a cached
copy is served, or the visitor is asked to retry in a minute. Caddy serves
`site/coin/index.html` for every `/coin/*` path.

## Charts

Charts in the table are TradingView's free embedded widget (the coin's main Binance pair), opened
under a coin's row; stablecoins have none. The market summary is assembled from
the prices; an AI-written brief and a per-coin "Why is it moving?" come next.

On phones the pages follow the layout of the market apps: four compact market
figures, a one-line market summary that opens on tap, underlined tabs (Top,
Watchlist, Trending, gainers, losers, stablecoins), a list of coin, price and
24h change with a sparkline, and a bottom bar (Markets, Watchlist, Mining,
About NIR). Saved to a phone's home screen, the site shows the NIR coin icon
(`apple-touch-icon.png`, `manifest.webmanifest`) and the name NIR Markets.

The watchlist (shared by the table and coin pages), theme and language stay in the visitor's browser; the page
needs no account and loads no trackers.
