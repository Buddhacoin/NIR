// What search engines read: the site map and a coin page's head filled in on the server. The pages draw
// their figures in the browser; a crawler that reads only the HTML gets the coin's name, price and summary
// from here (Caddy passes /coin/* and /sitemap.xml to the market service, deploy/install-shared-testnet.sh).

// The site's own pages worth finding; each coin of the market list adds its page.
export const SITE_PAGES = [
  ["/", "hourly", "1.0"], ["/charts/", "hourly", "0.8"], ["/about/", "monthly", "0.6"],
  ["/screener/", "hourly", "0.8"], ["/screener/heatmap/", "hourly", "0.8"], ["/screener/book/", "hourly", "0.8"],
  ["/screener/densities/", "hourly", "0.7"], ["/screener/liquidations/", "hourly", "0.7"],
  ["/screener/listings/", "daily", "0.7"], ["/screener/arbitrage/", "hourly", "0.7"],
  ["/transfers/", "hourly", "0.7"], ["/wallets/", "daily", "0.7"], ["/visualizer/", "monthly", "0.5"],
  ["/nir/", "weekly", "0.7"], ["/privacy/", "yearly", "0.2"], ["/terms/", "yearly", "0.2"],
];

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

// The address the visitor (or crawler) came by, as Caddy passes it on; anything odd falls back to the site's own.
export function siteBase(host) {
  if (typeof host !== "string" || !/^[a-z0-9.-]{1,100}(?::\d{1,5})?$/i.test(host)) return "https://nircoin.com";
  return /^(?:localhost|127\.0\.0\.1)(?::|$)/.test(host) ? `http://${host}` : `https://${host.toLowerCase()}`;
}

export function sitemap(base, coins) {
  const urls = [...SITE_PAGES, ...coins.map((coin) => [`/coin/${encodeURIComponent(coin.id)}`, "hourly", "0.6"])];
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(([path, changefreq, priority]) => `<url><loc>${escape(base + path)}</loc><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`).join("\n") +
    "\n</urlset>\n";
}

const usd = (value) => (value === null ? "—" : `$${value.toLocaleString("en-US", { maximumFractionDigits: value >= 1 ? 2 : 8 })}`);
const big = (value) => (value === null ? "—" : value >= 1e12 ? `$${(value / 1e12).toFixed(2)} трлн` : value >= 1e9 ? `$${(value / 1e9).toFixed(2)} млрд`
  : value >= 1e6 ? `$${(value / 1e6).toFixed(2)} млн` : usd(value));
const percent = (value) => (value === null ? "" : `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}% за 24 ч`);

// The coin page's HTML with its own title, description, address and name; a coin the server does not
// know yet gets the page as it is, with its address.
export function coinPage(template, base, id, coin) {
  const url = `${base}/coin/${encodeURIComponent(id)}`;
  let title = null;
  let description = null;
  if (coin) {
    title = `${coin.name} (${coin.symbol}) — цена, график и капитализация | NIR Markets`;
    description = `Курс ${coin.name} (${coin.symbol}) сегодня: ${usd(coin.price)}${coin.change24h === null ? "" : `, ${percent(coin.change24h)}`}. ` +
      `Капитализация ${big(coin.marketCap)}${coin.rank ? ` (№${coin.rank})` : ""}, объём за сутки ${big(coin.volume)}. ` +
      `График цены, биржи, кошельки и конвертер ${coin.symbol}.`;
  }
  let page = template;
  if (title) page = page.replace(/<title>[^<]*<\/title>/, `<title>${escape(title)}</title>`);
  if (description) page = page.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${escape(description)}">`);
  page = page.replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${escape(url)}">`)
    .replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${escape(url)}">`);
  if (title) page = page.replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${escape(title)}">`);
  if (description) page = page.replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${escape(description)}">`);
  if (coin) page = page.replace('<h1 id="name"></h1>', `<h1 id="name">${escape(coin.name)}</h1>`);
  return page;
}
