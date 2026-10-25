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

## Portfolio

`/portfolio/` follows the market sites' portfolio. A visitor makes named
portfolios ("folders", up to 20), each a set of coins; the side list shows
every portfolio's value and an Overview of them all. For the chosen one:

- the balance with its 24-hour change, and an eye button that hides amounts;
- the value over 24 hours, 7, 30 or 90 days or all time (History), or each
  coin's share as a ring (Allocation);
- Performance: the all-time profit in percent against the BTC trend over the
  same time;
- all-time profit, cost basis, and the best and worst coin by profit;
- Assets (price, 1h/24h/7d change, holdings, average buy price, profit; every
  column sorts) and Transactions (type, coin, price, amount, date, fee, note).

A transaction is a buy, a sale, or a transfer in or out: coins kept in a
wallet elsewhere. "Change holdings" in a coin's menu takes the amount the
visitor holds now and records the difference as a transfer. A coin can be
removed from a portfolio with its transactions, a portfolio renamed or
deleted, and the transactions exported as CSV. A sale or transfer out cannot
take more than the portfolio holds.

Profit uses the average-cost method: a sale takes coins at the average price
paid, so the cost basis is what the coins still held cost, and profit is the
current value minus that cost plus what sales realised, against everything
put in. A transfer in counts at the price of the day it is recorded, so its
profit starts from then; a transfer out takes coins away at the average cost
without a profit or loss. Fees add to a purchase's cost and come off a sale.

The value over time is worked out in the browser from each coin's price
history (`/market/chart/<id>`, cached on the server) and the transactions at
each moment; the fifteen largest holdings are traced, others count at today's
price. "All" reaches back to the first transaction, up to a year.

Signed out, portfolios stay in the browser (`localStorage`). Signed in, they
live in the accounts database (`blockchain/market-portfolio.mjs`) and follow
the visitor to any device; portfolios made before signing in join the account
on the next visit, and records from before portfolios existed join the
account's first portfolio. They are private: no profile or feed shows them.

| Method | Path | Does |
| --- | --- | --- |
| GET | `/market/me/portfolio` | portfolios and their records, newest first |
| POST | `/market/me/portfolios` | makes a portfolio: `{ name, transactions? }` |
| PUT, DELETE | `/market/me/portfolios/<id>` | renames a portfolio, or deletes it with its records |
| DELETE | `/market/me/portfolios/<id>/coins/<coin>` | removes a coin and its records from a portfolio |
| POST | `/market/me/portfolio` | adds `{ portfolioId, ...record }` or `{ portfolioId, transactions: [...] }` |
| PUT, DELETE | `/market/me/portfolio/<id>` | replaces or deletes a record |

A record is a coin id, `buy`, `sell`, `in` or `out`, a positive quantity, a
price per coin and an optional fee in US dollars, a time (2009 to a day
ahead) and a note of up to 200 characters. An account holds up to 2,000
records; changes need a same-site request and share the accounts' rate
limit. Deleting the account deletes its portfolios.

## Price alerts

A signed-in visitor sets alerts from the bell on a coin's page or on
`/alerts/`: the price goes above or below a level, or the coin rises or falls
by a percent within 24 hours; once, or every time the condition comes true
again. The bell in the header counts alerts that fired since the visitor last
opened `/alerts/`, and a page that is open shows a note when one fires.

The market service checks every switched-on alert against each minute's
prices (`blockchain/market-alerts.mjs`). Coins outside the top hundred that an
alert watches are priced in one extra request a minute. A one-time alert
switches off when it fires; a repeating one fires again only after its
condition has been false, so a price that stays above a level fires once,
not every minute.

Fired alerts also arrive as browser notifications, on a phone too, once the
visitor turns them on (on iPhone, from the site added to the Home Screen).
The server sends Web Push itself (`blockchain/market-push.mjs`, RFC 8291 and
RFC 8292 with `node:crypto`): the message is encrypted for that browser only,
and the server's VAPID key pair is made on first start and kept in the
accounts database. The service worker `/sw.js` shows the notification and
opens the coin's page when it is tapped; it caches nothing. Only addresses of
the browsers' own push services are accepted, so the server never sends
requests to an address a visitor picks.

| Method | Path | Does |
| --- | --- | --- |
| GET | `/market/me/alerts` | alerts, the last 50 firings, the unseen count and the push key |
| POST | `/market/me/alerts` | adds an alert: coin, name, symbol, `above`/`below`/`rise`/`fall`, value, repeat, language |
| PUT | `/market/me/alerts/<id>` | `{ active }` switches it on or off (on arms it again), or replaces it |
| DELETE | `/market/me/alerts/<id>` | deletes it |
| POST | `/market/me/alerts/seen` | marks firings as seen |
| POST, DELETE | `/market/me/push` | adds or removes this browser's push subscription |

Limits: 50 alerts and 10 browsers per account, the last 100 firings kept. A
browser whose push service says it has unsubscribed is dropped. Deleting the
account deletes its alerts, firings and browsers.

## Wallets and transfers

In the manner of the on-chain analytics sites, NIR Markets shows public
wallet activity (`blockchain/market-chain.mjs`):

- **All transfers**: a card on the home page and the page `/transfers/` show
  the newest token and coin transfers on the networks served by
  `eth.blockscout.com` and `explorer.optimism.io`, and the newest transfers of
  the five largest tokens on Base, Arbitrum, Polygon and the Binance Smart Chain, read from
  free public nodes (`blockchain/market-rpc.mjs`), with the sender, the
  receiver, the amount and its dollar value; filters by size ($1, $10K,
  $100K, $1M), network and token. The feed is fetched at most every 15
  seconds, whoever asks, and keeps the newest 400.
- **A wallet's page**, `/address/<address>`: its open name and tags, what it
  holds on every network with the total, the share per network, the network
  coin's balance by day, its transfers (all, inflow, outflow; spam-sized ones
  under $1 hidden by default) a page at a time, and its top counterparties
  among the loaded transfers. Addresses of the UTXO network are read from
  `mempool.space`. Header search opens a pasted address, and names such as
  `zeus.eth` are looked up in the name service.
- **Tracking**: signed in, "Track address" bookmarks a wallet and "This is
  mine" marks it as the visitor's own. The profile's "My addresses" tab adds
  up the holdings of all own wallets into one portfolio; "Tracked" lists the
  bookmarks with their balances. The list is private.

Everything is free and keyless. The node networks (Base, Arbitrum, Polygon and
the Binance Smart Chain, through `*.publicnode.com`) are read with Multicall3: one call
returns the coin and every listed token's balance, the listed tokens being
the 250 largest coins by market cap with a contract there (CoinGecko's coin
list, refreshed daily). A wallet's token transfers there come from the
nodes' logs over the last 49,000 blocks (about a day; hours on Arbitrum),
for its ten largest tokens; the coin's own transfers and balance history
need an explorer and are not shown. The free nodes refuse queries for more
than five contracts and block bursts, so requests to each node go one at a
time, 120 ms apart.

Names come from three places, in this order: names approved by NIR Markets
moderators, name-service records, and the explorers' open labels (verified
contract names, community tags). There is no private database of entities,
so most wallets show their address. A signed-in visitor can suggest a name
on any wallet's page, with a link to where it is published; moderators
(`NIR_MARKET_ADMINS`) approve or reject it in their profile's Moderation
tab, and an approved name shows on every transfer, wallet page and search
result with the tag "NIR Markets" (`blockchain/market-labels.mjs`: names of
2–40 characters, https links, ten suggestions per account a day).

Some explorers sit behind a bot challenge that turns server requests away;
only explorers that answer servers are used. An address holding thousands of
tokens can take an explorer minutes to list them; after 20 seconds the page
shows the network coin and says the tokens did not load. Every lookup is
cached (addresses, history and search for 10 minutes) and limited to 60
explorer requests a minute.

| Method | Path | Does |
| --- | --- | --- |
| GET | `/market/chain/feed?min=&chain=` | the newest transfers worth at least `min` dollars |
| GET | `/market/chain/address/<address>` | name, tags and holdings on every network |
| GET | `/market/chain/address/<address>/transfers?chain=&dir=all|in|out&cursor=` | transfers, a page at a time |
| GET | `/market/chain/address/<address>/history?chain=` | the network coin's balance by day |
| GET | `/market/chain/search?q=` | an address, or wallets by name |
| GET | `/market/me/addresses` | the visitor's saved addresses |
| PUT, DELETE | `/market/me/addresses/<address>` | saves `{ label?, mine? }`, or removes one |
| POST | `/market/labels` | suggests `{ address, name, link? }` |
| GET | `/market/labels/pending` | the queue, for moderators |
| POST | `/market/labels/<id>/approve`, `/market/labels/<id>/reject` | a moderator's decision |

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

The Sentiment column shows the share of "rise" votes from coin pages over the last 7 days (`GET /market/sentiment`), with a bar of rise against fall; a coin nobody voted on shows a dash. Every column header sorts the table (largest first, again to reverse, a third time back to rank). The table shows a 7-day line per coin; a row opens the coin's page with its
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
