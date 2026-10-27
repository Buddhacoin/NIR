// Open names and pictures for wallets: exchanges, funds, protocols and other
// known addresses, from the open labels Blockscout serves without a key
// (metadata.services.blockscout.com; much of it from the Open Labels
// Initiative). Each label gives a name and often the owner's site; the picture
// is the logo the label names, else the site's icon. Answers are kept a day
// (unknown addresses too, for ten minutes when the service did not answer),
// and addresses are asked fifty at a time. The same service lists every address
// under a group tag (exchanges, funds, hot wallets), fifty a page: the popular
// wallets directory pages through those lists.
//
// NIR Markets keeps its own book of wallet names (SQLite, `file`), which only grows: every label
// looked up, every wallet the search finds, and, in the background, every address of the open
// labels' group lists (exchanges, funds, hot and cold wallets, OTC desks, treasuries, well-known
// people), one page every few seconds, the lists walked again each week. The search reads the book
// first, so a name once seen is found at once and stays when a source is down.
import { DatabaseSync } from "node:sqlite";

const SERVICE = "https://metadata.services.blockscout.com/api/v1/metadata";
const LISTS = "https://metadata.services.blockscout.com/api/v1/addresses";
export const GROUPS = ["exchange", "fund", "hot-wallet"];
// Every group list the book copies, walked in this order.
export const CRAWLED = ["exchange", "fund", "hot-wallet", "cold-wallet", "otc", "treasury", "celebrity"];
const FAVICON = "https://www.google.com/s2/favicons?sz=64&domain=";
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Sites whose icon says nothing about the wallet's owner.
const SOCIAL = /(^|\.)(twitter\.com|x\.com|t\.me|telegram\.org|github\.com|medium\.com|discord\.(gg|com)|etherscan\.io|linktr\.ee)$/i;
const clean = (value, max) => (typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max) : "");
const httpsUrl = (value) => {
  try {
    const url = new URL(String(value).trim());
    return url.protocol === "https:" ? url : null;
  } catch { return null; }
};

// The best name tag of one address: { name, site, logo } or null.
export function readTags(tags) {
  const named = (Array.isArray(tags) ? tags : []).filter((tag) => tag?.tagType === "name" && clean(tag.name, 60))
    .sort((left, right) => (Number(right.ordinal) || 0) - (Number(left.ordinal) || 0));
  if (!named.length) return null;
  let meta = {};
  for (const tag of named) {
    try { meta = { ...JSON.parse(tag.meta || "{}"), ...meta }; } catch {}
  }
  // Keys arrive with stray spaces now and then ("tagIcon ").
  const field = (key) => Object.entries(meta).find(([name]) => name.trim() === key)?.[1];
  const linked = httpsUrl(field("tooltipUrl") ?? field("appMarketplaceURL") ?? "");
  const site = linked && !SOCIAL.test(linked.hostname) ? linked : null;
  const icon = [field("appLogoURL"), field("logoUrl"), field("tagIcon")].map(httpsUrl).find((url) => url && !/OLI_tag_logo/i.test(url.pathname));
  return {
    name: clean(named[0].name, 60),
    entity: clean(field("main_entity") ?? "", 40) || null,
    site: site ? site.origin : null,
    logo: icon ? icon.href.slice(0, 300) : site ? `${FAVICON}${site.hostname}` : null,
  };
}

export function createNames({ get, now = Date.now, ttl = 86_400_000, retry = 600_000, batch = 50, file = ":memory:" } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS wallet_names (address TEXT PRIMARY KEY, name TEXT, entity TEXT, site TEXT, logo TEXT,
      groups TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, checked_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS name_crawl (slug TEXT PRIMARY KEY, token TEXT, finished_at INTEGER NOT NULL DEFAULT 0);`);
  const sql = (text) => db.prepare(text);
  // A name is kept for good; it is asked again after a week, and an unnamed address after a day.
  const save = (address, value, source) => sql(`INSERT INTO wallet_names (address, name, entity, site, logo, source, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (address) DO UPDATE SET
      name = COALESCE(excluded.name, wallet_names.name), entity = COALESCE(excluded.entity, wallet_names.entity),
      site = COALESCE(excluded.site, wallet_names.site), logo = COALESCE(excluded.logo, wallet_names.logo),
      source = CASE WHEN excluded.name IS NULL THEN wallet_names.source ELSE excluded.source END, checked_at = excluded.checked_at`)
    .run(address, value?.name ?? null, value?.entity ?? null, value?.site ?? null, value?.logo ?? null, source, now());
  const stored = (address) => {
    const row = sql("SELECT name, entity, site, logo, checked_at FROM wallet_names WHERE address = ?").get(address);
    if (!row) return null;
    const value = row.name ? { name: row.name, entity: row.entity, site: row.site, logo: row.logo } : null;
    return { value, until: row.checked_at + (value ? 7 * ttl : ttl) };
  };
  const known = new Map(); // lower-case address → { at, until, value }
  const asking = new Map(); // lower-case address → the lookup in flight
  const fresh = (address) => {
    if (!known.has(address)) { const row = stored(address); if (row) known.set(address, row); }
    const entry = known.get(address);
    return entry && now() < entry.until;
  };

  // Looks the addresses up (the ones not known yet); resolves once they are in.
  async function lookup(addresses) {
    const wanted = [...new Set(addresses.filter((address) => EVM_ADDRESS.test(address ?? "")).map((address) => address.toLowerCase()))];
    const missing = wanted.filter((address) => !fresh(address) && !asking.has(address));
    for (let start = 0; start < missing.length; start += batch) {
      const group = missing.slice(start, start + batch);
      const job = (async () => {
        let answer = null;
        try { answer = await get(`${SERVICE}?addresses=${group.join(",")}&chainId=1`); } catch {}
        const byAddress = new Map(Object.entries(answer?.addresses ?? {}).map(([address, entry]) => [address.toLowerCase(), entry]));
        for (const address of group) {
          const value = byAddress.has(address) ? readTags(byAddress.get(address)?.tags) : null;
          // The book keeps the old name when the service did not answer.
          if (answer) save(address, value, "labels");
          known.set(address, answer ? { until: now() + (value ? 7 * ttl : ttl), value } : { until: now() + retry, value: stored(address)?.value ?? null });
          asking.delete(address);
        }
        if (known.size > 50_000) for (const key of [...known.keys()].slice(0, 10_000)) known.delete(key);
      })();
      for (const address of group) asking.set(address, job);
    }
    await Promise.all(wanted.map((address) => asking.get(address)).filter(Boolean));
  }
  const name = (address) => {
    if (typeof address !== "string") return null;
    const key = address.toLowerCase();
    if (!known.has(key)) { const row = stored(key); if (row) known.set(key, row); }
    return known.get(key)?.value ?? null;
  };

  // Wallets found elsewhere (the explorer's search, the name service) join the book.
  function remember(items, source) {
    for (const item of items) {
      if (!EVM_ADDRESS.test(item?.address ?? "") || !clean(item.name, 60)) continue;
      const key = item.address.toLowerCase();
      const old = sql("SELECT name, source FROM wallet_names WHERE address = ?").get(key);
      if (old?.name && old.source === "labels") continue; // an open label outranks a search hit
      save(key, { name: clean(item.name, 60), entity: clean(item.entity ?? "", 40) || null, site: null, logo: item.logo ?? null }, source);
      known.delete(key);
    }
  }
  // The book's wallets whose name or organisation contains the words; spaces do not count.
  function search(text, limit = 10) {
    const needle = String(text ?? "").toLowerCase().replace(/\s+/g, "").replace(/[%_]/g, "");
    if (needle.length < 2) return [];
    const like = `%${needle}%`;
    return sql(`SELECT address, name, entity, logo, groups FROM wallet_names WHERE name IS NOT NULL
      AND (REPLACE(LOWER(name), ' ', '') LIKE ? OR REPLACE(LOWER(IFNULL(entity, '')), ' ', '') LIKE ?)
      ORDER BY REPLACE(LOWER(name), ' ', '') LIKE ? DESC, groups != '' DESC, LENGTH(name) LIMIT ?`).all(like, like, `${needle}%`, limit)
      .map((row) => ({ address: row.address, name: row.name, entity: row.entity, logo: row.logo, groups: row.groups ? row.groups.split(",") : [] }));
  }
  const count = () => sql("SELECT COUNT(*) AS n FROM wallet_names WHERE name IS NOT NULL").get().n;

  // One page of the next group list into the book; a list walked to its end is walked again in a week.
  async function crawl() {
    const due = CRAWLED.find((slug) => (sql("SELECT finished_at FROM name_crawl WHERE slug = ?").get(slug)?.finished_at ?? 0) < now() - 7 * ttl);
    if (!due) return false;
    const token = sql("SELECT token FROM name_crawl WHERE slug = ?").get(due)?.token ?? null;
    const answer = await get(`${LISTS}?slug=${due}&tagType=generic&chain_id=1&page_size=50${token ? `&page_token=${encodeURIComponent(token)}` : ""}`);
    const addresses = (Array.isArray(answer?.items) ? answer.items : []).filter((address) => EVM_ADDRESS.test(address)).map((address) => address.toLowerCase());
    await lookup(addresses);
    for (const address of addresses) {
      save(address, name(address), "labels");
      sql(`UPDATE wallet_names SET groups = CASE WHEN groups = '' THEN ? WHEN (',' || groups || ',') LIKE ? THEN groups ELSE groups || ',' || ? END
        WHERE address = ?`).run(due, `%,${due},%`, due, address);
    }
    const next = typeof answer?.next_page_params?.page_token === "string" && EVM_ADDRESS.test(answer.next_page_params.page_token)
      ? answer.next_page_params.page_token : null;
    sql(`INSERT INTO name_crawl (slug, token, finished_at) VALUES (?, ?, ?) ON CONFLICT (slug) DO UPDATE SET token = excluded.token,
      finished_at = excluded.finished_at`).run(due, next, next ? 0 : now());
    return true;
  }
  // The background walk: a page every few seconds, never two at once, a failure waits a minute.
  // Open books of labelled wallets (Etherscan's labels, copied under the MIT licence at
  // github.com/brianleect/etherscan-labels), read once a week: a name fills an address the book has no
  // name for, and never replaces one. Scam, phishing and similar labels are left out.
  const BOOKS = ["etherscan", "bscscan", "polygonscan", "arbiscan", "optimism"]
    .map((folder) => `https://raw.githubusercontent.com/brianleect/etherscan-labels/main/data/${folder}/combined/combinedAllLabels.json`);
  const SKIP = /phish|hack|scam|exploit|heist|blocked|take-action|airdrop-hunter|spam|fake/i;
  function importBook(book, source) {
    const fill = sql(`INSERT INTO wallet_names (address, name, entity, site, logo, source, checked_at) VALUES (?, ?, NULL, NULL, NULL, ?, ?)
      ON CONFLICT (address) DO UPDATE SET name = excluded.name, source = excluded.source WHERE wallet_names.name IS NULL`);
    let added = 0;
    db.exec("BEGIN");
    try {
      for (const [address, value] of Object.entries(book ?? {})) {
        const name = clean(value?.name ?? "", 60);
        const labels = Array.isArray(value?.labels) ? value.labels.join(" ") : "";
        if (!EVM_ADDRESS.test(address) || !name || SKIP.test(`${name} ${labels}`)) continue;
        added += Number(fill.run(address.toLowerCase(), name, source, now()).changes);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    known.clear();
    return added;
  }
  let booksAt = 0;
  async function importBooks() {
    if (now() - booksAt < 7 * 86_400_000) return 0;
    booksAt = now();
    let added = 0;
    for (const url of BOOKS) added += importBook(await get(url).catch(() => null), "open-book");
    return added;
  }
  function start(every = 5_000) {
    void importBooks().catch(() => {});
    const weekly = setInterval(() => { void importBooks().catch(() => {}); }, 86_400_000);
    weekly.unref?.();
    let busy = false;
    let pauseUntil = 0;
    const timer = setInterval(() => {
      if (busy || now() < pauseUntil) return;
      busy = true;
      crawl().catch(() => { pauseUntil = now() + 60_000; }).finally(() => { busy = false; });
    }, every);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // One page of a group's addresses with their names and pictures; pages are kept six hours.
  const pages = new Map();
  async function directory(group, token = null) {
    if (!GROUPS.includes(group)) return null;
    const key = `${group}:${token ?? ""}`;
    const hit = pages.get(key);
    if (hit && now() - hit.at < 6 * 3_600_000) return hit.value;
    const answer = await get(`${LISTS}?slug=${group}&tagType=generic&chain_id=1&page_size=50${token ? `&page_token=${encodeURIComponent(token)}` : ""}`);
    const addresses = (Array.isArray(answer?.items) ? answer.items : []).filter((address) => EVM_ADDRESS.test(address));
    await lookup(addresses);
    const next = typeof answer?.next_page_params?.page_token === "string" && EVM_ADDRESS.test(answer.next_page_params.page_token)
      ? answer.next_page_params.page_token : null;
    const value = { items: addresses.map((address) => ({ address, ...(name(address) ?? { name: null, entity: null, site: null, logo: null }) })), next };
    pages.set(key, { at: now(), value });
    if (pages.size > 500) pages.delete(pages.keys().next().value);
    return value;
  }
  // An organisation's known wallets: those its label names as the entity, or whose name starts with it
  // ("Binance 14", "Binance: Hot Wallet"); the busiest names first, at most `limit`.
  function members(entity, limit = 40) {
    const wanted = String(entity ?? "").trim();
    if (wanted.length < 2 || wanted.length > 60) return [];
    const like = `${wanted.replace(/[%_\\]/g, (char) => `\\${char}`)}%`;
    return sql(`SELECT address, name, entity, logo FROM wallet_names WHERE name IS NOT NULL AND (entity = ? COLLATE NOCASE
      OR name = ? COLLATE NOCASE OR name LIKE ? ESCAPE '\\' AND (substr(name, ?, 1) IN (':', ' ', '(')) ) LIMIT ?`)
      .all(wanted, wanted, `${wanted}%`.replace(/%$/, "%"), wanted.length + 1, limit)
      .filter((row) => !/exploit|scam|phish|deposit/i.test(row.name))
      .map((row) => ({ address: row.address, name: row.name, logo: row.logo ?? null }));
  }
  return { lookup, name, directory, remember, search, count, crawl, start, members, importBook, importBooks };
}
