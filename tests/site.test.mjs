import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the Mac installer is valid bash, pins Node.js like the server, and verifies what it downloads", () => {
  const installer = read("site/install.sh");
  assert.equal(spawnSync("bash", ["-n", "site/install.sh"], { cwd: new URL("..", import.meta.url) }).status, 0);
  const pinned = (text) => /NODE_VERSION="([0-9.]+)"/.exec(text)[1];
  assert.equal(pinned(installer), pinned(read("deploy/install-shared-testnet.sh")));
  assert.match(installer, /shasum -a 256 -c/);
  assert.match(installer, /pkgutil --check-signature/);
  assert.match(installer, /Developer ID Installer: Python Software Foundation/);
  assert.match(installer, /^set -euo pipefail$/m);
  assert.doesNotMatch(installer, /\bread\b -/, "piped from curl, the script cannot read answers");
});

test("the website links only files it ships and shows the same install command", () => {
  // The markets page is the home page; the NIR page moved to /nir/.
  for (const page of ["site/index.html", "site/nir/index.html", "site/coin/index.html", "site/u/index.html",
    "site/privacy/index.html", "site/terms/index.html", "site/charts/index.html", "site/portfolio/index.html", "site/alerts/index.html", "site/address/index.html", "site/transfers/index.html", "site/wallets/index.html", "site/screener/index.html", "site/visualizer/index.html", "site/screener/densities/index.html", "site/entity/index.html"]) {
    const html = read(page);
    for (const [, file] of html.matchAll(/(?:src|href)="([^"#:?]+)(?:\?[^"]*)?"/g)) {
      const target = file.startsWith("/") ? new URL(`../site${file}`, import.meta.url)
        : new URL(`../${page.replace(/[^/]+$/, "")}${file}`, import.meta.url);
      const path = target.pathname.endsWith("/") ? new URL("index.html", target) : target;
      assert.ok(existsSync(path), `${page}: missing ${file}`);
    }
  }
  const html = read("site/nir/index.html");
  assert.match(html, /curl -fsSL https:\/\/nircoin\.com\/install\.sh \| bash/);
  assert.match(read("docs/install-mac.md"), /curl -fsSL https:\/\/nircoin\.com\/install\.sh \| bash/);
  // A versioned URL makes browsers drop a cached stylesheet or script from an older page.
  assert.match(html, /href="\/style\.css\?v=\d+"/);
  assert.match(html, /src="\/app\.js\?v=\d+"/);
  const app = read("site/app.js");
  for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) {
    assert.match(app, new RegExp(`\\b${key}:`), `no English text for ${key}`);
  }
});

test("the markets home page has English for every text and links to NIR", () => {
  const html = read("site/index.html");
  const script = read("site/markets.js");
  for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) {
    assert.match(script, new RegExp(`\\b${key}:`), `no English text for ${key}`);
  }
  assert.match(html, /<a href="\/nir\/">[^\n]*data-i18n="navNir"/, "the menu leads to the NIR page");
  assert.match(html, /<a href="\/#watch" data-member hidden>/, "the watchlist link is for signed-in visitors");
  // CoinGecko's free plan asks for credit; TradingView credits itself inside its chart.
  assert.match(html, /<span data-i18n="dataBy">Данные:<\/span> <span data-i18n="dataExchanges">биржи<\/span>, CoinGecko/);
  assert.match(script, /fetch\("\/market\/overview"/);
  assert.match(read("site/common.js"), /fetch\("\/api\/v1\/stats"/);
  assert.match(script, /location\.href = coinUrl\(coin\)/, "a coin's row opens its page");
  const deploy = read("deploy/install-shared-testnet.sh");
  assert.match(deploy, /handle \/market\/\* \{\n\s+reverse_proxy 127\.0\.0\.1:8790/);
  // A coin's page comes from the market service, with the coin's figures in its HTML (market-seo.mjs).
  assert.match(deploy, /handle \/coin\/\* \{\n\s+rewrite \* \/market\/page\{path\}\n\s+reverse_proxy 127\.0\.0\.1:8790/);
  assert.match(deploy, /handle \/sitemap\.xml \{\n\s+rewrite \* \/market\/sitemap\.xml/);
  assert.match(deploy, /market-service-cli\.mjs 8790/);
});

test("a coin's page has English for every text and loads its data from the market service", () => {
  const html = read("site/coin/index.html");
  const script = read("site/coin.js");
  for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) {
    assert.match(script, new RegExp(`\\b${key}:`), `no English text for ${key}`);
  }
  for (const page of [html, read("site/index.html")]) {
    assert.match(page, /src="\/common\.js\?v=\d+"/);
    assert.match(page, /href="\/markets\.css\?v=\d+"/);
  }
  assert.match(script, /fetch\(`\/market\/coin\/\$\{encodeURIComponent\(id\)\}`/);
  assert.match(script, /fetch\(`\/market\/chart\/\$\{encodeURIComponent\(id\)\}\?days=/);
  // Text from CoinGecko is only ever set as text, never as HTML.
  assert.doesNotMatch(script, /innerHTML\s*=\s*[^'"]*(?:coin|ticker|description)/);
  assert.match(html, /<span data-i18n="dataBy">Данные:<\/span> CoinGecko/);
});

test("profiles have English for every text and the server keeps accounts outside the repository", () => {
  const html = read("site/u/index.html");
  const script = read("site/profile.js");
  for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) {
    assert.match(script, new RegExp(`\\b${key}:`), `no English text for ${key}`);
  }
  const deploy = read("deploy/install-shared-testnet.sh");
  assert.match(deploy, /handle \/u\/\* \{\n\s+root \* \$APP_DIR\/site\n\s+rewrite \* \/u\/index\.html/);
  assert.match(deploy, /StateDirectory=nir-market/);
  assert.match(deploy, /Environment=NIR_MARKET_DB=\/var\/lib\/nir-market\/accounts\.db/);
  assert.doesNotMatch(deploy, /GOOGLE_CLIENT_SECRET=/, "the Google secret never goes into the repository");
  assert.match(deploy, /www\.\$SITE_DOMAIN \{\n\s+redir https:\/\/\$SITE_DOMAIN\{uri\} permanent/);
});

test("the market overview page has English for every text", () => {
  const html = read("site/charts/index.html");
  const script = read("site/charts.js");
  for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) {
    assert.match(script, new RegExp(`\\b${key}:`), `no English text for ${key}`);
  }
  assert.match(script, /fetch\("\/market\/fear-greed"\)/);
});

test("the portfolio page has English for every text and keeps records on the server once signed in", () => {
  const html = read("site/portfolio/index.html");
  const script = read("site/portfolio.js");
  for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) {
    assert.match(script, new RegExp(`\\b${key}:`), `no English text for ${key}`);
  }
  assert.match(script, /"\/market\/me\/portfolio"/);
  // Every page's menu leads to the portfolio.
  for (const page of ["site/index.html", "site/coin/index.html", "site/charts/index.html", "site/u/index.html", "site/portfolio/index.html"]) {
    assert.match(read(page), /href="\/portfolio\/"/, page);
  }
});

test("price alerts have English for every text, a service worker and a bell on every page", () => {
  const html = read("site/alerts/index.html");
  const script = read("site/alerts.js");
  for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) {
    assert.match(script, new RegExp(`\\b${key}:`), `no English text for ${key}`);
  }
  const shared = read("site/alerts-ui.js");
  // The dialog's Russian and English texts have the same keys.
  const keys = (block) => [...block.matchAll(/(\w+): "/g)].map(([, key]) => key).sort();
  const [, ru, english] = /ru: \{([^]*?)\},\n  en: \{([^]*?)\},\n\};/.exec(shared);
  assert.deepEqual(keys(ru), keys(english));
  assert.match(shared, /navigator\.serviceWorker\.register\("\/sw\.js"\)/);
  assert.match(read("site/sw.js"), /addEventListener\("push"/);
  assert.match(read("site/coin/index.html"), /src="\/alerts-ui\.js\?v=\d+"/);
  assert.match(read("site/common.js"), /href: "\/alerts\/"/);
});

test("the explorer pages have English for every text, and the server routes wallet pages", () => {
  for (const [page, script] of [["site/address/index.html", "site/address.js"], ["site/transfers/index.html", "site/transfers.js"], ["site/wallets/index.html", "site/wallets.js"], ["site/visualizer/index.html", "site/visualizer.js"]]) {
    const html = read(page);
    const code = read(script);
    for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) assert.match(code, new RegExp(`\\b${key}:`), `${script}: no English text for ${key}`);
    assert.match(code, /\/market\/chain\//);
  }
  assert.match(read("site/index.html"), /id="transfers"/);
  assert.match(read("site/markets.js"), /\/market\/chain\/feed/);
  // The wallet's transfers sort by time, value and dollars, and filter by sender, receiver and token.
  const wallet = read("site/address/index.html");
  for (const key of ["time", "amount", "usd"]) assert.match(wallet, new RegExp(`data-tsort="${key}"`));
  for (const key of ["from", "to", "token"]) assert.match(wallet, new RegExp(`data-tfilter="${key}"`));
  // The search offers popular wallets.
  assert.match(read("site/common.js"), /const WHALES = \[/);
  assert.match(read("deploy/install-shared-testnet.sh"), /handle \/address\/\* \{\n\s+root \* \$APP_DIR\/site\n\s+rewrite \* \/address\/index\.html/);
  const profile = read("site/u/index.html");
  for (const key of ["tabWallets", "tabTracked", "tabModeration"]) {
    assert.match(profile, new RegExp(`data-i18n="${key}"`));
    assert.match(read("site/profile.js"), new RegExp(`\\b${key}:`));
  }
});

test("the server serves the website with the network's read API under /api", () => {
  const script = read("deploy/install-shared-testnet.sh");
  assert.match(script, /SITE_DOMAIN="\$\{2:-\}"/);
  assert.match(script, /handle_path \/api\/\* \{\n\s+reverse_proxy 127\.0\.0\.1:8787/);
  assert.match(script, /root \* \$APP_DIR\/site/);
  assert.equal(spawnSync("bash", ["-n", "deploy/install-shared-testnet.sh"],
    { cwd: new URL("..", import.meta.url) }).status, 0);
});

test("the density screener page has English for every text and reads the server's walls", () => {
  const html = read("site/screener/densities/index.html");
  const code = read("site/densities.js");
  for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) assert.match(code, new RegExp(`\\b${key}:`), `densities.js: no English text for ${key}`);
  assert.match(code, /fetch\("\/market\/densities"\)/);
  assert.match(read("site/screener/index.html"), /href="\/screener\/densities\/"/, "the trend screener links to the walls");
});

test("the arbitrage screener page has English for every text and reads the server's price gaps", () => {
  const html = read("site/screener/arbitrage/index.html");
  const code = read("site/arbitrage.js");
  for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) assert.match(code, new RegExp(`\\b${key}:`), `arbitrage.js: no English text for ${key}`);
  assert.match(code, /fetch\("\/market\/arbitrage"\)/);
  for (const page of ["site/screener/index.html", "site/screener/densities/index.html"]) assert.match(read(page), /href="\/screener\/arbitrage\/"/);
});

test("an organisation's page adds up its known wallets, and popular wallets link to it", () => {
  const html = read("site/entity/index.html");
  const code = read("site/entity.js");
  for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) assert.match(code, new RegExp(`\\b${key}:`), `entity.js: no English text for ${key}`);
  assert.match(code, /\/market\/chain\/entity\?name=/);
  assert.match(read("site/wallets.js"), /\/market\/chain\/entities\?names=/);
});

test("every page script parses", () => {
  // A typo in one script (a stray quote in a text) would break a whole page without failing any other test.
  for (const name of readdirSync(new URL("../site/", import.meta.url)).filter((file) => file.endsWith(".js"))) {
    const result = spawnSync(process.execPath, ["--check", `site/${name}`], { cwd: new URL("..", import.meta.url) });
    assert.equal(result.status, 0, `site/${name}: ${result.stderr}`);
  }
});

test("the liquidations and listings pages have English for every text and read their server lists", () => {
  for (const [page, script, api] of [["site/screener/liquidations/index.html", "site/liquidations.js", "/market/liquidations"], ["site/screener/listings/index.html", "site/listings.js", "/market/listings"]]) {
    const html = read(page);
    const code = read(script);
    for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) assert.match(code, new RegExp(`\\b${key}:`), `${script}: no English text for ${key}`);
    assert.ok(code.includes(`fetch("${api}")`));
  }
  for (const page of ["site/screener/index.html", "site/screener/densities/index.html", "site/screener/arbitrage/index.html"]) {
    assert.match(read(page), /href="\/screener\/liquidations\/"/);
    assert.match(read(page), /href="\/screener\/listings\/"/);
  }
});

test("the heatmap page has English for every text, and every screener links to it", () => {
  const html = read("site/screener/heatmap/index.html");
  const code = read("site/heatmap.js");
  for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) assert.match(code, new RegExp(`\\b${key}:`), `heatmap.js: no English text for ${key}`);
  for (const page of ["site/screener/index.html", "site/screener/densities/index.html", "site/screener/arbitrage/index.html", "site/screener/liquidations/index.html", "site/screener/listings/index.html"]) {
    assert.match(read(page), /href="\/screener\/heatmap\/"/);
  }
});
