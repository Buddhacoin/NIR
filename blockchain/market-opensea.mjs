// OpenSea profiles for wallets (needs OPENSEA_API_KEY, free from opensea.io → Settings → Developer):
// the username a wallet's owner chose on OpenSea, their picture and the X account they linked. A
// username is the owner's own choice, not a checked identity, so it is shown as "OpenSea: <name>",
// and as checked only when the profile links an X account. Answers are kept a day (a wallet without
// a profile too), and no more than `perMinute` questions go to OpenSea a minute.
//
// account("0x…" | "username") → { address, username, picture, x, checked } | null
const API = "https://api.opensea.io/api/v2/accounts";
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const USERNAME = /^[A-Za-z0-9_.-]{3,40}$/;
const text = (value, max) => (typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max) : "");

// One profile from OpenSea's answer, or null when it names no one.
export function readAccount(answer) {
  const address = text(answer?.address, 42);
  const username = text(answer?.username, 40);
  if (!EVM_ADDRESS.test(address) || !USERNAME.test(username) || /^0x[0-9a-f]{6,}$/i.test(username)) return null;
  const linked = (Array.isArray(answer.social_media_accounts) ? answer.social_media_accounts : [])
    .find((item) => /^(twitter|x)$/i.test(item?.platform ?? "") && /^[A-Za-z0-9_]{1,15}$/.test(item?.username ?? ""));
  const picture = /^https:\/\/[^\s"'<>]{1,300}$/.test(answer.profile_image_url ?? "") ? answer.profile_image_url : null;
  return { address, username, picture, x: linked ? linked.username : null, checked: Boolean(linked) };
}

export function createOpenSea({ key, get, now = Date.now, perMinute = 50 } = {}) {
  if (!key) return null;
  const known = new Map(); // lower-case address or username → { until, value }
  const pending = new Map();
  let used = [];
  async function account(id) {
    const wanted = String(id ?? "").trim();
    if (!EVM_ADDRESS.test(wanted) && !USERNAME.test(wanted)) return null;
    const cacheKey = wanted.toLowerCase();
    const hit = known.get(cacheKey);
    if (hit && now() < hit.until) return hit.value;
    if (pending.has(cacheKey)) return pending.get(cacheKey);
    used = used.filter((at) => now() - at < 60_000);
    if (used.length >= perMinute) return hit?.value ?? null; // past the budget: what is known, or nothing
    used.push(now());
    const job = (async () => {
      try {
        const value = readAccount(await get(`${API}/${encodeURIComponent(wanted)}`, { "x-api-key": key }));
        known.set(cacheKey, { until: now() + 86_400_000, value });
        if (value) known.set(value.address.toLowerCase(), { until: now() + 86_400_000, value });
        if (known.size > 20_000) known.delete(known.keys().next().value);
        return value;
      } catch {
        known.set(cacheKey, { until: now() + 600_000, value: hit?.value ?? null });
        return hit?.value ?? null;
      }
    })();
    pending.set(cacheKey, job);
    try { return await job; } finally { pending.delete(cacheKey); }
  }
  return { account };
}
