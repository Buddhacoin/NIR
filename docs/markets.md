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

## Design and navigation

Day theme: white with a blue accent (#3861fb), thin grey dividers, green
#16c784 and red #ea3943 for changes, like the big market sites. Night theme:
graphite with glass cards and a violet–mint accent. Orange is kept only in the
NIR coin.

- A strip on top of every page: coins tracked, exchanges, market cap, 24h
  volume, dominance, Fear & Greed and NIR's own network; the market items open
  the overview page.
- Every card is a link: market status and its figures → `/charts/`, Fear &
  Greed → `/charts/#fear-greed`, dominance → `/charts/#dominance`; the Trending
  and Gainers titles switch the table to those lists.
- `/charts/` (Market overview): totals, the Fear & Greed gauge with yesterday,
  last week, last month, the yearly high and low and a year-long chart
  (`GET /market/fear-greed`, alternative.me, cached an hour), and the
  dominance of the largest coins.
- The table has a Circulating supply column with a bar towards the maximum
  supply; numbers take only the width they need. Every coin CoinGecko lists
  can be browsed 100 a page: `/?page=N` loads `GET /market/coins?page=N`
  (cached three minutes, within the coin-fetch budget), with page numbers and
  "Showing 1–100 of N" under the table.
- CoinGecko's free plan asks for credit: a small "Данные: CoinGecko" under the
  table and in the footers. TradingView credits itself inside its chart.

## Search

The search box covers every coin CoinGecko lists. Before typing it shows
recent searches (kept in the browser) and trending coins; while typing it
shows matches from the top 100 at once and then the rest from
`GET /market/search?q=…`, each query cached for 10 minutes.

## Accounts: Google sign-in, profiles and the watchlist

Visitors can sign in with Google (`blockchain/market-accounts.mjs`, inside the
market service). The first sign-in creates an account at once with a username
like `user482913` and a letter avatar; nothing else is asked. The email stays
on the server and is never shown. A profile lives at `/u/<username>` and shows
the name, bio, join date and activity; anyone sees that the user joined (and,
next, their comments), while the owner also sees their own watchlist changes,
the watchlist itself and an Edit form (name up to 20 characters, username
3–20 letters, digits or `_` and changeable once a week, bio up to 250).
`/u/me` opens your own profile.

Signed in, the watchlist is kept on the server and follows you to any device;
stars set before signing in are added to it on the first visit. Signed out,
it stays in the browser as before.

How it works: OpenID Connect code flow with PKCE, state and nonce; the ID
token from Google's token endpoint is checked for issuer, audience, expiry,
nonce and a verified email. The session is a random token in an HttpOnly,
Secure, SameSite=Lax `__Host-` cookie for 30 days; the database keeps only its
SHA-256. Changes must come from the site itself (Origin header) and are
limited to 60 a minute per account. Data: `/var/lib/nir-market/accounts.db`
(SQLite, `StateDirectory=nir-market`). `www.` redirects to the main address
so the cookie and Google's callback always match.

### Discussion on a coin's page

Each coin's page has a Discussion block (`blockchain/market-community.mjs`):

- **The daily vote** "How do you feel about X today?": Rise or Fall, one vote
  per account per coin per UTC day; the split shows after voting.
- **Comments**: up to 1,000 characters with an optional Rise/Fall tag, sorted
  by Latest or Top, one level of replies, likes. One comment per 20 seconds
  and 50 a day per account. A comment and its replies can be deleted by the
  author or a moderator; three reports from different accounts hide it.
  Moderators are the Google emails listed in `NIR_MARKET_ADMINS`
  (comma-separated) in `/etc/nir-market.env`.
- A profile shows its comments (public) and "commented on X" in its activity.

Signed-out visitors read; posting, liking, reporting and voting need an
account. The block is shown when sign-in is on or there is already something
to read.

Anyone can delete their account in Profile → Edit → Delete account; it removes
the account, its sessions, watchlist, activity, comments (with replies),
likes, reports and votes at once. The privacy policy and terms of use are at
`/privacy/` and `/terms/`; Google's consent screen links to both.

### Turning on Google sign-in

Until the keys are set, the site works as before and shows no sign-in button.

1. Open console.cloud.google.com, create a project (for example "NIR
   Markets"), then **APIs & Services → OAuth consent screen**: External, app
   name "NIR Markets", support email, the domain `nircoin.com`; scopes
   `openid`, `email`, `profile`; publish the app.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   type "Web application"; authorised JavaScript origin
   `https://nircoin.com`; authorised redirect URI
   `https://nircoin.com/market/auth/google/callback`.
3. Copy the Client ID and Client secret. On the server (DigitalOcean Web
   Console) run, with your values:

   ```
   cat >> /etc/nir-market.env <<'EOF'
   GOOGLE_CLIENT_ID=paste-the-client-id
   GOOGLE_CLIENT_SECRET=paste-the-client-secret
   EOF
   chmod 600 /etc/nir-market.env && systemctl restart nir-market.service
   ```

Never put the secret in the repository or in a chat.

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

The table shows a 7-day line per coin; a row opens the coin's page with its
full chart. Long names are cut short there, with the full name on hover. The market summary is assembled from
the prices; an AI-written brief and a per-coin "Why is it moving?" come next.

A coin's page draws its own chart of price or market capitalisation for 24
hours to a year: the line is green above the period's opening value and red
below it, that value is dotted, the scale and the latest value's tag are on
the right, time and volume underneath, and a crosshair shows any point. The
TradingView button swaps in the full chart with candles, indicators and
drawing tools for coins with a Binance pair.

On phones the pages follow the layout of the market apps: four compact market
figures, a one-line market summary that opens on tap, underlined tabs (Top,
Watchlist, Trending, gainers, losers, stablecoins), a list of coin, price and
24h change with a sparkline, and a bottom bar (Markets, Watchlist, Mining,
About NIR). Saved to a phone's home screen, the site shows the NIR coin icon
(`apple-touch-icon.png`, `manifest.webmanifest`) and the name NIR Markets.

The watchlist (shared by the table and coin pages), theme and language stay in the visitor's browser; the page
needs no account and loads no trackers.
