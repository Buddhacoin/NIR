# NIR Markets (nircoin.com)

The home page of nircoin.com is **NIR Markets**: prices of the 100 largest
coins, the whole market, what is trending, top gainers, the Fear & Greed index
and a short market summary, in Russian and English, with day and night
themes. It is useful to traders who know nothing about NIR yet; the NIR logo
leads to the NIR page at `/nir/`, and a strip on top shows NIR's own network
(miners, pioneers, NIR mined) with a button to start mining.

## Data

`blockchain/market-service.mjs` runs on the website's server
(`nir-market.service`, `127.0.0.1:8790`, `npm run market:serve`). It fetches,
each source on its own clock:

- CoinGecko: `/coins/markets` (top 100 with 1h/24h/7d changes and 7-day
  sparklines) every minute, `/global` every three minutes and
  `/search/trending` every five;
- alternative.me: the Fear & Greed index every ten minutes.

A failing source is asked again only when it is next due, and one refresh
runs at a time. A "too many requests" answer from CoinGecko pauses every
background call (trending rows, exchange logos, alerts, coin warming) for two
minutes, so the visitors' own requests get the room.

It serves every visitor from that copy at `GET /market/overview` (Caddy passes
`/market/*` to it), so the free sources see one client however many people
visit. A source that fails keeps its last good data. A free CoinGecko demo key
can be set as `COINGECKO_API_KEY` in `/etc/nir-market.env`. The page credits
CoinGecko for prices and TradingView for charts.

## Prices that match the market

- A coin page's kept copy (CoinGecko busy, or read back from `cache.db`) takes the market list's price, changes, cap and volume when it is over a minute old, and a kept chart ends at the current price; the week stand-in chart ends at it too. "Updated" moves only when the prices were read. CoinGecko is asked for full precision (`precision=full`), so prices over $1 are not rounded to cents; the site shows four decimals under $10.
- The trending card shows the list's row of each coin. Network coins' live trades say they trade as their wrapped token.
- The trend screener's day change comes from the busiest market reporting a rolling 24 hours (MEXC counts from its midnight). Arbitrage buys at the ask and sells at the bid (Binance's ticker has neither: its last price). Exchange prices show as the exchange gives them (up to eight digits).
- The order book shows each exchange's own pair (Coinbase and Kraken quote dollars) and BTC-quoted money in BTC; OKX futures candles count coins, not contracts. A dropped Binance stream starts its book again from the next snapshot (no cancelled far wall stays), and a failed OKX instruments read is asked again.
- Coin logos come through the site's server (`/market/logo/coin/<id>/<size>/<file>`, market-logos.mjs), kept on disk, fetched ahead for the market list every ten minutes and sent for a month of browser cache; CoinGecko's own carry no caching headers, so phones fetched them on every page.

## Figures in place, pages ready before the tap

- A list that refreshes (the home table, its cards and small heatmap, the screeners) lays its new rows over the ones on screen (`patchList` in `site/common.js`): a row of the same coin is kept and only the text and colours that changed are rewritten, so the figures change in place and pictures are not loaded again.
- Browsers with speculation rules (Chrome, Edge) fetch the bottom menu's pages ahead and prepare a linked page whole when the pointer or finger heads for it; pages fade into each other (`@view-transition`) instead of flashing blank.
- The order book has a price step choice beside the market, as on the exchanges' books (the exchange's own prices, then 10, 50, 100… of its tick), and its columns say what they count: "Qty (ETH)", or "Value ($)" in dollar mode.
- On a phone a wallet's head is laid out as on the analytics apps: the picture beside the name, the actions as icons on that row, the networks in one row that scrolls.
- CoinGecko's global figures: a zero market cap or volume (it sometimes answers so) keeps the last good one.

## The site's own prices

`blockchain/market-prices.mjs` reads the spot tickers of OKX, Gate, Bitget, KuCoin and Bybit every 20 seconds (one request each, no key). A coin's price is the volume-weighted average of the markets within 2 % of their median, turned into dollars at the stablecoin's own price; its day change from the same markets' prices a day ago. The market list, the coin pages and the sitemap take these over CoinGecko's figures where the exchanges agree with the list's price within 10 % (another coin under the same ticker stays out); the market cap follows the price (price × circulating supply). CoinGecko still gives the list itself, supply, descriptions, charts and trending. The last good list is kept in `cache.db`, so a restart while the sources are down opens with it; when CoinGecko has not answered for five minutes, CoinPaprika's free list (`/v1/tickers`) stands in, matched to the coins the site knows (their ids, pictures and week lines kept).

## Wallets the site finds itself

- `/wallets/` has two lists that grow on their own: **Whales** — the wallets the most money went through in 30 days in NIR Markets' own store of transfers (`ledger.busiest`), with the book's name when it has one (token contracts, routers, pools and bridges left out); **Found** — the newest names found from wallets' behaviour (`names.found`), marked as such (`GET /market/chain/popular?group=whales|found`).
- Behaviour no longer takes a wallet that only takes in for a hot wallet (it must pay out about as often, `ledger.sent`): the first block's address, which many send keepsakes to, was marked an exchange. Such an earlier guess is taken back on the next hourly run (`names.retract`).
- The list's balances ask again while a big wallet's tokens are still being counted, so the list and the wallet's page show the same sum; Satoshi Nakamoto's row (all his early coins) leads to his organisation page.
- A coin or token the lists have no picture for (a new listing, a tokenised share) gets one by its ticker from the server (`/market/logo/symbol/<TICKER>`: CoinGecko's search, the open icon sets, a share's logo), kept once found. A listing's "price now" is its price on the exchange that listed it.
- The order book's price step sits with the book; big orders stand out on both sides with a stronger bar, a band and an edge in the side's colour.

## Search engines

The pages draw their figures in the browser, so what a crawler reads is in the
HTML: each page has its title, description, canonical address and Open Graph
tags, and each tool ends with a short "How it works" in both languages
(`.explain`, the page's language shown). `/about/` lists every section and
where its data comes from; the footer links it. `site/robots.txt` keeps
crawlers out of the visitor's own pages (portfolio, alerts, profiles) and
points at `/sitemap.xml`, which the market service writes
(`blockchain/market-seo.mjs`, `GET /market/sitemap.xml`): the site's pages
and every coin of the market list. A coin's page (`/coin/<id>`) comes from the
service too (`GET /market/page/coin/<id>`): `site/coin/index.html` with the
coin's name, price, change, market cap and volume in its title, description
and heading; a coin outside the list gets the page as it is. Caddy passes both
addresses to it.

## Design and navigation

Day theme: white with a blue accent (#3861fb), thin grey dividers, green
#16c784 and red #ea3943 for changes, like the big market sites. Night theme:
graphite with glass cards and a violet–mint accent. Orange is kept only in the
NIR coin.

- The header: Cryptocurrencies, Gainers & losers and Market overview, then,
  as small grey links with icons by the search, Watchlist and Portfolio
  (shown to signed-in visitors only; the watchlist is an account's, and a
  star clicked signed out leads to signing in) and About NIR. On phones the
  bottom bar carries them the same way.
- A strip on top of every page: coins tracked, exchanges, market cap, 24h
  volume, dominance, Fear & Greed, NIR's own network and the number of
  registered users; the market items open the overview page.
- The home page's market status also counts how many of the top 100 coins
  rose in 24 hours, and an altcoin-season score: the share of the top 50
  (stablecoins aside) that beat the largest coin over 7 days (75 and more:
  altcoin season, 25 and less: the largest coin's season).
- The four cards keep one height: the transfers card takes the row's height
  from its neighbours and its list clips inside, so new transfers or a
  filter with nothing to show never shift the page.
- Every card is a link: market status and its figures → `/charts/`, Fear &
  Greed → `/charts/#fear-greed`, dominance → `/charts/#dominance`; the Trending
  and Gainers titles switch the table below to the full lists (the fifteen
  trending coins; every top coin by its 24-hour change, highest first, or
  lowest first under Losers). `/#trending`, `/#gainers` and `/#losers` open
  those lists, so the menu's "Gainers & losers" lands on them. Trending coins
  outside the top hundred come with their full rows (one more request). A
  change CoinGecko leaves out (young or thinly traded coins) is read off the
  hourly 7-day prices; a coin younger than the span shows none.
- The sentiment column shows NIR Markets' own rise votes over 7 days; where
  there are none yet, the CoinGecko community's share of rise votes over a
  day (read for one coin every 20 seconds and kept a day); where neither
  exists, a "Rate" link to the coin's vote.
- `/charts/` (Market overview): totals, the Fear & Greed gauge with yesterday,
  last week, last month, the yearly high and low and a year-long chart
  (`GET /market/fear-greed`, alternative.me, cached an hour), and the
  dominance of the largest coins.
- The table has a Circulating supply column with a bar towards the maximum
  supply; numbers take only the width they need. Every coin CoinGecko lists
  can be browsed 100 a page: `/?page=N` loads `GET /market/coins?page=N`
  (cached three minutes, within the coin-fetch budget), with page numbers and
  "Showing 1–100 of N" under the table. The Watchlist tab also shows starred
  coins outside the top 100, from `GET /market/coins?ids=a,b` (up to 50 ids,
  cached two minutes).
- CoinGecko's free plan asks for credit: a small "Данные: CoinGecko" under the
  table and in the footers. TradingView credits itself inside its chart.

## Search

The search box covers every coin CoinGecko lists. Before typing it shows
recent searches (kept in the browser) and trending coins; while typing it
shows matches from the top 100 at once and then the rest from
`GET /market/search?q=…`, each query cached for 10 minutes.

As on the on-chain analytics sites, everything is searched at once and shown
in sections: **Wallets and entities** first (the popular wallets, then, from
three letters, `GET /market/chain/search?q=`: the explorer's quick search,
whose open labels name wallets such as a fund's or a market maker's, with
their organisation, labelled wallets first, an hour's cache; a name with
spaces is also asked without them, so "black rock" finds BlackRock; and,
for a person's name, the name-service names made of it: "First Last"
tries firstlast.eth, first-last.eth and flast.eth, each that exists shown
after the labelled wallets as the name it is, without claiming whose it is),
then **Coins**. The popular wallets page's filter asks the same search, so a
wallet beyond the loaded lists is found by its name too.

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

### Profile pictures

A user may choose a picture with "Change photo" in the profile form (Edit). The page cuts it to a square and sends a 128 px
JPEG (`PUT /market/me/avatar`, a data address of at most 12 KB whose bytes
must match its kind; `DELETE` removes it). It is served from
`GET /market/avatar/<username>` and shows on the profile, in the header and
next to the user's comments; without one, the coloured letter stays.

### The owner's dashboard

On their own profile, above the activity tabs, the owner sees four quadrants
over the wallets they marked as their own (`site/dashboard.js`), as on the
on-chain analytics sites; empty until a wallet is added. The total of the
wallets stands under the owner's name, with the network choice beside the
profile's buttons:

1. **Portfolio**: every token across networks and accounts with its price,
   amount and value and the day's change of each; **Holdings by chain**: the
   value per network with its share; **Portfolio archive**: two dates and the
   amounts held on each, rebuilt from the loaded transfers.
2. **Balances history** (1W, 1M, 3M, All), rebuilt from the transfers of all
   own wallets at today's prices, and **Profit & loss** over 24 hours and 7
   days from the price changes on today's amounts.
3. **Transactions**, **Inflow** and **Outflow** of all own wallets, sortable by
   time, amount and dollars, with transfers under $0.10 hidden until the chip
   is removed; more pages load on request.
4. **All accounts**: each wallet with its largest holding, the count of the
   others and its value, a tab of its own with its tokens, × to remove it and
   "Add +" (right after All accounts) to add one, by connecting MetaMask (the browser wallet gives its public
   address, nothing else) or by pasting an address. The addresses are private.

Choosing an account or a network (top right) narrows every quadrant. The
menu below (Activity, Comments, Watchlist, My addresses, Tracked) stays.

Own wallets on the profile sit in named portfolios ("Main", "Trading"…, up to
20; `POST /market/me/wallet-portfolios`, `PATCH`/`DELETE …/wallet-portfolios/<id>`):
the dashboard shows one portfolio at a time, a bar over it switches between
them, makes a new one, renames or deletes the chosen one (its wallets stay
under Tracked), and "Add +" puts a wallet into the chosen portfolio. Own
wallets saved before portfolios existed join a first one. "Watch wallet" on
a wallet's page saves it under Tracked and links there.
The profile's sections stand in a row under its head: "Tracking" (the
owner's dashboard of portfolios, shown first), Activity, Comments,
Watchlist, My addresses and Tracked; one shows at a time, and a link such
as `/u/<name>#tracked` opens that section.

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

On a phone the page follows the market apps: the portfolio's name with ⇅
opens a bottom sheet listing every portfolio with its value (plus Edit and
Add), the balance stands with its 24-hour and all-time lines, the side list
and the wide cards step aside, a round + adds a transaction, and each asset
row keeps the price with its day change and the holdings. The popular
wallets list likewise shows each wallet's balance under its name on a phone,
so nothing has to be scrolled sideways.

On every page a phone's bottom menu floats as a frosted glass bubble over the
content, and pulling the page down from its top reloads it (also in the app
saved to the home screen, where the browser's own gesture is missing).

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

## Screeners

`/screener/` (in the header menu and among the home page's tabs) is the trend
screener (`blockchain/market-screener.mjs`, `GET /market/screener`): every
perpetual futures market of the exchanges that answer without a key (Bitget,
OKX, Gate, MEXC), merged by coin, about 800 coins. One request per exchange a
minute brings price, the day's change, range and volume, open interest and
funding for all of them; the busiest market sets price and change, volumes
and open interest add up, funding is weighted by volume, and a market far
off the busiest one's price (another coin under the same ticker) is left
out. Changes over 5 and 15 minutes, 1 and 4 hours, and open interest over the
hour and the day come from the server's own snapshots, one a minute kept for
a day; when the server starts, coins without four hours of them take five-minute
candles from Bitget or Gate once (about 40 seconds for all), and the snapshots are
saved beside the accounts database (`screener.json`) every ten minutes, so a
restart keeps them. Coin pages and charts fetched from CoinGecko are kept on disk
too (`cache.db`), so after a restart a coin seen before opens at once from its copy
while a fresh one is fetched behind it. Each coin among the 1,000 largest gets its logo and a link to
its page (the explorer's coin lists, `coinOfSymbol`). The page picks the period that sets the order, has
ready filters (gainers, losers, open interest rising, high funding, volatile),
a minimum volume and a search, colours each change by its size and
refreshes every half minute; on a phone it keeps the coin with the chosen
period's change under it, the price and the volume. The liquidations screener (`/screener/liquidations/`,
`blockchain/market-liquidations.mjs`, `GET /market/liquidations`) listens to the
public streams of forced closes on the futures of Binance (every coin), Bybit
(the 100 busiest) and OKX (every coin), and reads OKX's liquidation list for
the 30 busiest coins every two minutes in case a stream is cut. The last day
is kept and saved beside the accounts (`liquidations.json`): the longs and
shorts closed over the hour, four hours and day, each coin's totals, and the
last hour's events (each counted once even when a stream and the list both
bring it). The new-listings screener (`/screener/listings/`, `GET
/market/listings`) notes every futures market that appears on one of the six
exchanges after the trend screener began watching it, with the coin's price
then and now, for 30 days. The heatmap (`/screener/heatmap/`, `site/heatmap.js`)
needs no service of its own: it lays the top coins of the market overview
(sized by market cap; 1 h, 24 h or 7 d change) or the trend screener's futures
coins (sized by day volume; 5 m to 24 h change) out as a squarified treemap,
coloured by the change, stablecoins left out unless asked for.

The order book screener (`/screener/book/`, `site/book.js`,
`blockchain/market-book.mjs`): one pair on one of eight exchanges, spot or
futures (Binance — its spot market turns the server's country, the Netherlands, away even on its market-data addresses, so when the server cannot read it the visitor's browser reads the book, trades and candles straight from `data-api.binance.vision`, which allows any site: 5,000 levels every ten seconds and the nearest 1,000 every two —, Bybit, OKX with their futures, Coinbase, Kraken, Bitstamp,
Bitfinex, HitBTC), or several side by side in the constructor. `GET
/market/book?ex=…&base=…&quote=…` reads the exchange's public book (no key) at
most every two seconds whoever asks and sends the exchange's own price levels
(each side's 800 largest within its whole reach and its 200 nearest whatever their size, so the book starts at the price, each with the volume from the
best price through it) and each side's totals out to every whole per cent. Depth: Coinbase, Bitstamp and HitBTC
answer with their whole book; Bitfinex is read at three precisions (exact near
the price, coarser further out); Binance (spot and futures) is kept in full
depth by the server from the exchange's stream of every change on top of a
snapshot, re-read every ten minutes and on any gap; Bybit (spot and futures)
from its stream's 1,000 levels (its REST answer has 200 or 500); for the pairs looked at in
the last half hour and the trend screener's six busiest all the time; OKX and Kraken
give what their open answers hold (a few per cent around the price). The page
says how far each book reaches. `/market/book/trades` and
`/market/book/candles?tf=1m…1d` read the latest trades and candles the same
way (candles every twenty seconds); exchanges that quote dollars answer for
the stablecoin. As on the order-book tools, the page shows the exchange's own prices (a
price step in the settings gathers them), keeps the levels of at least the
smallest order within the chosen depth (5–60 %, 90 % or MAX, the default),
shows a big order's whole row lighter and bold, sums every order of each side
within the depth, gives the volume from the price through a row on a pointer, filters the trades feed by
the smallest trade, and draws the big orders on a candle chart as levels
(green under the price, red above; hide, depth and reversed colours in the
chart settings). Thresholds left empty follow the book (the smallest order shown is the
fortieth largest level within 1% of the price, about twenty a side near it as on the order-book tools; the eight biggest are big); a dollar mode sets and shows them in dollars.
Settings stay in the browser. The chart is TradingView's Lightweight Charts
(`site/vendor/lightweight-charts.js`, Apache 2.0, credited in the footer).

The chart has tools along its left side, as on the trading terminals: a
cursor, horizontal and trend lines, a ruler giving the move between two
points in per cent, price and candles, erasing the drawings and fitting the
whole chart, and indicators (volume, MA 20 and 50, EMA 200); drawings are kept
in the browser for each exchange and pair. In the constructor each exchange
may have its own smallest and big order (its gear beside its price). The
statistics mode reads the exchange's daily candles: for the last 7, 14 and 30
days the open, close, low, high, average daily volatility ((high − low) / open)
and volume; today's expected range (its open ± the 7-day average volatility);
and every day back as far as the candles go.

Pages open at once, as in an app (`site/common.js`, `site/sw.js`): the last
answers of the data a page starts from (the market overview, the visitor's
portfolio, wallets and profile) are kept in the browser for a minute or two
and handed to the page straight away while a fresh copy is fetched behind
them, and any change the visitor makes drops their kept copies; the account
as last seen draws the menus before the server answers; the service worker
keeps versioned scripts and styles for good, answers a page from its kept
copy when the server takes over a second, and fetches the bottom menu's pages
and the visitor's data ahead while the browser is idle. Caddy marks versioned
files immutable.

`/screener/densities/` is the order-book density screener
(`blockchain/market-densities.mjs`, `GET /market/densities`): big resting limit
orders ("walls") in the perpetual futures books of Binance, Bybit, OKX and
Bitget, read without a key. Each exchange's books are read one after another
at its own pace, well inside its public limits (about one a second on Binance,
whose deep books weigh more, three a second elsewhere), the trend screener's
100 busiest coins first, so each book is read about once a minute. A level
within 5% of the price is a wall when it is worth at least $100K and a share
of the coin's day volume, and at least four times the average level near
the price; the biggest five a side are kept. A wall keeps the time its price
was first seen, so the page shows how long it has stood. The page filters
by side, exchange, size, distance and age, draws a bar behind each size,
links each coin to its page and refreshes every ten seconds; on a phone it
keeps the coin with the side and exchange under it, the size and the
distance.

## Wallets and transfers

In the manner of the on-chain analytics sites, NIR Markets shows public
wallet activity (`blockchain/market-chain.mjs`):

- **All transfers**: a card on the home page and the page `/transfers/` show
  the newest token and coin transfers on the networks served by
  `eth.blockscout.com` and `explorer.optimism.io`, and the newest transfers of
  the five largest tokens on Base, Arbitrum, Polygon and the Binance Smart Chain, read from
  free public nodes (`blockchain/market-rpc.mjs`), with the sender, the
  receiver, the amount and its dollar value; filters by size ($1, $10K,
  $100K, $1M), network and token. The service refreshes the feed itself
  every 15 seconds and keeps the newest 400, so visitors get the last copy
  at once instead of waiting for the explorers and nodes.
- **A wallet's page**, `/address/<address>`, laid out like the analytics
  sites: four panels with tabs across the top and tables that scroll inside.
  Its open name, tags and picture (the name-service avatar when there is one;
  other wallets get a colour of their own), what it holds on every network
  with the total (a coin listed on the site opens its page), the share per
  network, the balance history (1W, 1M, 3M, 1Y, all), the split by asset as a
  ring, its transfers on all networks at once or on one (all, inflow, outflow;
  ones under $1, mostly spam, hidden by default with a count and "show all"),
  and its top counterparties.
- A network counts as the wallet's when it holds something there or left any
  trace (a transaction sent, a token or a transfer): such networks show as
  chips with the number of transactions sent, their transfers load under
  "All", and an empty wallet says where it was active, with links to the
  explorers.
- The wallet's transfers table works like the analytics sites': Time sorts
  (click again to flip); Value and USD open a panel with a from–to range,
  quick thresholds ($1 to $1M) and the order; From and To filter by address
  or name; Token filters by one of the loaded tokens; "Clear filters" undoes
  them.
- **Popular wallets**: the search, opened empty, offers well-known public
  wallets (exchanges, funds, market makers, a government, founders, and
  well-known people by the name-service name they set on their own wallet;
  their own published or widely reported addresses, listed in `site/common.js`)
  next to recent searches and trending tokens with their day's change;
  typing a name finds them, and their names and pictures (the
  organisation's site icon, or the person's name-service avatar) show
  wherever they appear. The section titles open the full lists:
  `/wallets/` and the trending coins.
- **Popular wallets** (`/wallets/`): the hand-picked wallets above, and
  thousands more from the open labels in three tabs, exchanges, funds and
  hot wallets; the first tab, All, holds every one of them (`GET /market/chain/popular?group=exchange|fund|hot-wallet&cursor=`,
  fifty a page from Blockscout's address directory, each page kept six
  hours). Every row has the name, logo, organisation, networks, balance and a
  Track button; the next page loads by itself as the list scrolls, a filter
  searches the loaded names and addresses, and balances load only for the
  rows on screen, two at a time.
- **Balance history** is rebuilt in the browser from the transfers: today's
  holdings, with each loaded transfer undone going back in time, valued at
  today's prices (tokens without a price count as nothing). Older pages load
  by themselves until the chosen period is covered (eight at most); the note
  above the chart says from when the history is complete. The node networks
  reach back hours to days, so when a wallet holds something on a network
  with an explorer, the explorers' reach sets the period. Addresses of the UTXO network are read from
  `mempool.space`. Header search opens a pasted address, and names such as
  `zeus.eth` are looked up in the name service.
- **Tracking**: signed in, "Track address" bookmarks a wallet and "This is
  mine" marks it as the visitor's own. The profile's "My addresses" tab adds
  up the holdings of all own wallets into one portfolio; "Tracked" lists the
  bookmarks with their balances. The list is private.

Everything is free and keyless. The node networks (Base, Arbitrum, Polygon and
the Binance Smart Chain, through `*.publicnode.com`) are read with Multicall3: one call
returns the coin and every listed token's balance, the listed tokens being
the 1,000 largest coins by market cap with a contract there (CoinGecko's coin
list, refreshed daily; four pages of the market list every five minutes).
On the main explorer network a wallet's tokens come first from Ethplorer's
free API (`freekey`): every token with a price, in a second or two even for
thousands of tokens; tokens held by fewer than a thousand wallets are left
out, since spam sent to well-known wallets often carries a made-up price.
Token pictures are NIR Markets' own (`blockchain/market-logos.mjs`): the
first time a wallet page shows a token, its picture is fetched once (the
coin's CoinGecko logo, the source's own picture, Trust Wallet's open assets
catalogue by the token's mixed-case address, the token's site icon, in that
order), checked to be a real PNG, JPEG, WebP or GIF, saved beside the
database (`logos/`) and served from `GET /market/logo/<network>/<contract |
native-SYMBOL>` for a month of browser cache; a token no source has is
looked for again the next day. The explorer networks (`eth` and `optimism`) read a wallet's tokens from the
explorer, which can take minutes for a wallet holding thousands of tokens; the
same one-call read from the network's public node runs alongside, and when the
explorer has not answered in six seconds the listed tokens come from the node
and the page says so. A wallet's token transfers there come from the
nodes' logs for the network's ten largest tokens, a page at a time going
back: each page reads windows of blocks, the first of 600 and each next four
times wider up to what the node allows (Base 49,000; Polygon and the Binance
Smart Chain 9,999; Arbitrum 99,000, read from the network's own free node
`arb1.arbitrum.io`), until it has twenty transfers, eight windows or ten
seconds, and at most two hundred. The coin's own transfers need an explorer
and are not shown. The free nodes refuse queries for more than five
contracts and block bursts, so requests to each node go one at a time,
120 ms apart, and a refused request (403, 429) is tried twice more. Node
requests stay out of the explorers' budget of 60 a minute and have their own
of 30 a minute. A wallet whose last fetch failed shows its last copy, or
answers "busy" for twenty seconds instead of asking the nodes again at once.

Names come from four places, in this order: names approved by NIR Markets
moderators, name-service records, the explorers' labels (verified contract
names, community tags), and the open labels Blockscout serves without a key
(`blockchain/market-names.mjs`, metadata.services.blockscout.com, much of it
from the Open Labels Initiative), which name exchanges, funds, market makers
and protocols and bring their pictures: the logo the label names, else the
owner's site icon. They are asked fifty addresses at a time;
`GET /market/chain/names?addresses=` answers them for a page.

NIR Markets keeps its own book of wallet names (`names.db` beside the
accounts database), which only grows and stays when a source is down: every
open label looked up (a named wallet asked again after a week, an unnamed one
after a day), every wallet the search finds (labelled wallets and name-service
names, not contracts; an open label outranks a search hit), name-service names
seen in transfers, and, in the background, every address of the open labels'
group lists (exchanges, funds, hot and cold wallets, OTC desks, treasuries,
well-known people), one page of fifty every five seconds, walked again each
week. The search reads the book first. Wallets no source names still show
their address.

With `OPENSEA_API_KEY` in `/etc/nir-market.env` (free: opensea.io →
Settings → Developer → Create API key), OpenSea profiles add to this
(`blockchain/market-opensea.mjs`): a wallet page with no label shows the
OpenSea username its owner chose, their picture and the X account they
linked, and the profile joins the book; the search tries the OpenSea
usernames made of the words ("First Last" → firstlast, first_last). A
username is the owner's own choice, not a checked identity: it shows as
"OpenSea", as checked only when the profile links an X account, and
unchecked profiles come after the labelled wallets. Answers are kept a day,
at most 50 questions a minute. A signed-in visitor can suggest a name
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
| GET | `/market/stats` | `{ users }`, the number of accounts, for the bar at the top |
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


**Visualizer** (`/visualizer/?address=…`, the "◉ Links" button on a wallet's
page, `site/visualizer.js`): the wallet in the middle and the wallets it
exchanged coins with around it, as bubbles with the open name's logo, or
its name or the start of its address written inside. Every transfer is a
thin curve of its own (green: coins came to the wallet, red: they left it),
so a busy pair shows as a sheaf of lines (the newest 24 of them). Filters: how many links (25,
50, 100), by sum or by time, the smallest sum and the network. Bubbles can be
dragged, the picture panned and zoomed (with two fingers on a phone); a
bubble's card shows what passed between the two wallets and can expand that
wallet's own links in place, open its page or make it the centre. Its links come in one request from NIR Markets' own store of transfers
(`blockchain/market-ledger.mjs`, `transfers.db` beside the accounts
database, `GET /market/chain/address/<address>/links`): every transfer the
service reads (the live feed, any wallet's pages) is kept there, and asking
for a wallet's links starts a crawl of its pages: the newest page of every
network at once (again once it is ten minutes old), then up to 40 older
pages a network, one request at a time, so the explorers are never flooded.
The page shows what the store has at once and asks again every few seconds
while the crawl goes on; the store keeps the newest three million transfers.
Every list of wallets (transfers, counterparties, popular wallets, the
profile) has a round bubbles button beside each wallet, and a wallet's page
the "Bubbles: links" button.


**Open books of labelled wallets**: once a week the names book also reads the
open copies of Etherscan's labels for the main network, the Binance chain,
Polygon, Arbitrum and Optimism (github.com/brianleect/etherscan-labels, MIT
licence), about 40,000 named addresses; a name fills an address the book has
no name for and never replaces one, and scam, phishing and similar labels
are left out.

**Satoshi Nakamoto** (`blockchain/market-patoshi.mjs`, `GET
/market/chain/satoshi`, `patoshi.db`): the 21,953 early blocks that by Sergio
Demian Lerner's "Patoshi" research Satoshi mined each paid 50 coins to a public
key of their own (the list of keys from github.com/RandyMcMillan/patoshi-
addresses). The service reads the list once, then asks mempool.space about
each key (the SHA-256 of its pay-to-public-key script), one every half second,
about three hours for all and again a month later. Keys not read yet count as
their untouched 50 coins. His organisation page, his row in the popular list
and his genesis address's page show the sum (about 1.1 million coins) and say
that the attribution is the research's conclusion.

**Organisations** (`/entity/?name=…`, `GET /market/chain/entity?name=…&extra=…`,
`GET /market/chain/entities?names=…`): an organisation shows as one wallet,
as on the analytics sites. The server takes every address its book knows for
it (its label names it, or its name starts with it, as in "Binance 14" or
"Binance: Hot Wallet"; exploiters and deposit addresses left out), up to 300,
plus its wallets in the popular list, reads their balances in the background
two at a time (kept half an hour) and answers with the total, the assets
added up by token and network, its recent transfers from the store of
transfers with its own side shown as its name, how many addresses it has and
one of them half hidden. The addresses themselves stay on the server, so the
book cannot be copied off the site. A visitor follows the organisation as a
whole: "+ Add to portfolio" saves it as `entity:<name>` in their first
portfolio of wallets, where the Tracking tab shows its balance and
transfers. An address's page shows a badge beside its name with how many
addresses its organisation has ("53 addresses"), linking to that page. In the
popular list an organisation with several known wallets links to its page
("39 wallets →").

**The book of attributions** (`names.db`, `market-names.mjs`): each name has
the kind of its owner (exchange, fund, market maker, bridge, DeFi,
government, miner, custodian, company, person, whale or other), read from the
open labels' group lists, the books' label words and the name itself; the
address page shows it as a tag. Every name, owner or kind an address is given
is written to its history with the source and time (`label_history`).
Every hour `market-behaviour.mjs` reads the last 90 days of the store of
transfers for the pattern of exchange deposit addresses: a wallet that sent
everything (two transfers or more) to one wallet of an exchange becomes
"<exchange>: Deposit", and an unnamed wallet fed by 25 or more such wallets is
marked a likely exchange without a name. Guesses never replace a name from any
other source and show as "by behaviour".

The arbitrage screener (`/screener/arbitrage/`, `GET /market/arbitrage`) uses
the trend screener's readings, which now take Binance's and Bybit's tickers
too: for each coin on two exchanges or more (each with $100K a day or more),
where it is cheapest and dearest, the gap in percent, the gap in funding
between those two markets, and the smaller day volume. Filters: the smallest
gap, the smallest volume, an exchange that must be one of the two, a coin.
Bare addresses everywhere carry a copy button instead of a coloured dot; only
named wallets have a picture.
## A coin's page

Every coin has its own page at `/coin/<id>` (the CoinGecko id, e.g.
`/coin/zeus-token`); a row in the table, a trending coin or a top gainer opens
it. It shows the price with 1h/24h/7d changes and the 24h range, market cap,
volume, fully diluted value, supply, all-time high and low, links (website,
whitepaper, source, block explorers, well-known wallets, community), a
converter, a price chart for 1 day to 1 year with volume bars (TradingView
candles; every coin TradingView knows opens on its full chart with drawing
tools and indicators, the largest coin on its cross-exchange index and the
rest on their pair on Binance or another big exchange TradingView carries, else on
the bare ticker pair while its markets are not known yet (a coin known to trade on
no big exchange, such as a fund's token, keeps the line chart), and the line chart stays one click away), the description (Russian when
CoinGecko has it) and the markets where the coin trades, each with the
exchange's logo (CoinGecko's exchange list, fetched once a day; the trust
column shows only when some market has a rating). The page is one panel, its
columns and sections divided by thin lines rather than separate cards, and the
chart takes the whole middle column at 520 px high. The page spans the
window and the side columns take about a quarter each (331 px at 1440 px,
442 and 390 px at 1920 px, as on the big market sites). On wide screens (1400 px
and more) the discussion stands in a third column beside the chart, as on the
big market sites: the day's vote on top, the comments scrolling inside, the
post box at the bottom.

**Live trades**: under the chart, the latest 300 swaps in the coin's busiest
decentralised-exchange pool (`blockchain/market-trades.mjs`, from
GeckoTerminal's free API; network coins trade as their wrapped tokens), as on
the DEX trade screens: time, buy or sell, price, total with its size (flea
under $1, shrimp to $1K, fish to $3K, dolphin to $10K, whale above), amount,
the wallet (an EVM wallet opens its page here) and the transaction. Time,
price, total and amount sort; type, size and wallet filter; a bar weighs the
dollars bought against those sold; new trades flash as they arrive. Network coins (traded as their wrapped tokens) start at
once; tokens once the coin's contracts are known. The pool
is looked up once an hour and its trades at most every 15 seconds, whoever
asks (`GET /market/trades?network=&token=`).

**The page never waits on a busy source.** It opens at once from the market
list the browser already has; a coin seen before is served from its copy
while a fresh one is fetched behind it; when CoinGecko is busy and the coin
was never fetched, the server answers from the market list (price, changes,
cap, supply, the week's prices) and the page asks again until it has
everything. A coin in the market list never waits more than 2.5 seconds for
CoinGecko: past that it is answered from the list while the fetch finishes
behind it. Any chart period that is not ready yet is drawn from the week's
prices, marked "showing the week while the chosen period loads", and the
page swaps in the full chart when it comes. CoinGecko's free plan allows few requests a minute: a "too many"
answer pauses the background work (warming coin pages one at a time, which
also brings the community votes) for two minutes, so visitors' pages get the
room.

The page asks the market service for `GET /market/coin/<id>` and
`GET /market/chart/<id>?days=1|7|30|90|365`. Those are fetched only when
someone opens the page: a coin is kept for 2 minutes, a chart for 5 to 30
minutes, visitors asking for the same coin at once share one fetch, and no
more than 20 such fetches go to CoinGecko a minute (search has its own
budget of 6 a minute and needs two letters). A failed fetch keeps the old
copy for another minute instead of asking again on every visit; a failed
trades lookup waits a minute too. Past that limit a cached
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
