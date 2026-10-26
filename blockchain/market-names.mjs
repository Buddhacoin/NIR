// Open names and pictures for wallets: exchanges, funds, protocols and other
// known addresses, from the open labels Blockscout serves without a key
// (metadata.services.blockscout.com; much of it from the Open Labels
// Initiative). Each label gives a name and often the owner's site; the picture
// is the logo the label names, else the site's icon. Answers are kept a day
// (unknown addresses too, for ten minutes when the service did not answer),
// and addresses are asked fifty at a time. The same service lists every address
// under a group tag (exchanges, funds, hot wallets), fifty a page: the popular
// wallets directory pages through those lists.

const SERVICE = "https://metadata.services.blockscout.com/api/v1/metadata";
const LISTS = "https://metadata.services.blockscout.com/api/v1/addresses";
export const GROUPS = ["exchange", "fund", "hot-wallet"];
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

export function createNames({ get, now = Date.now, ttl = 86_400_000, retry = 600_000, batch = 50 } = {}) {
  const known = new Map(); // lower-case address → { at, until, value }
  const asking = new Map(); // lower-case address → the lookup in flight
  const fresh = (address) => { const entry = known.get(address); return entry && now() < entry.until; };

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
          known.set(address, { until: now() + (answer ? ttl : retry), value });
          asking.delete(address);
        }
        if (known.size > 50_000) for (const key of [...known.keys()].slice(0, 10_000)) known.delete(key);
      })();
      for (const address of group) asking.set(address, job);
    }
    await Promise.all(wanted.map((address) => asking.get(address)).filter(Boolean));
  }
  const name = (address) => (typeof address === "string" ? known.get(address.toLowerCase())?.value ?? null : null);

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
  return { lookup, name, directory };
}
