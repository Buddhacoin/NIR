// Live trades of a coin, as on the DEX trade screens: the latest swaps in the
// coin's busiest decentralised-exchange pool, from GeckoTerminal's free API
// (no key; about 30 requests a minute). The page names the network and the
// token contract; the pool is looked up once an hour, its trades at most every
// 15 seconds, whoever asks, and past the budget the last copy is served.
//
// GET /market/trades?network=<GeckoTerminal network id>&token=<contract>
//   → { pool: { name, address, dex, network }, trades: [{ time, kind, price, usd, amount, maker, tx }], buys, sells }

const API = "https://api.geckoterminal.com/api/v2";
const NETWORK = /^[a-z0-9][a-z0-9_-]{1,30}$/;
const TOKEN = /^[A-Za-z0-9]{20,70}$/;
const number = (value) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

// The busiest pool whose base token is the coin.
export function choosePool(answer, network, token) {
  const own = `${network}_${token}`.toLowerCase();
  const pools = (Array.isArray(answer?.data) ? answer.data : [])
    .filter((pool) => String(pool?.relationships?.base_token?.data?.id ?? "").toLowerCase() === own)
    .sort((left, right) => (number(right.attributes?.volume_usd?.h24) ?? 0) - (number(left.attributes?.volume_usd?.h24) ?? 0));
  const pool = pools[0];
  if (!pool) return null;
  return { name: text(pool.attributes?.name, 60), address: text(pool.attributes?.address, 80), network,
    dex: text(pool.relationships?.dex?.data?.id, 40) };
}

// One swap seen from the coin: bought or sold, at what price, for how many dollars and coins.
export function readTrades(answer, token) {
  const own = token.toLowerCase();
  return (Array.isArray(answer?.data) ? answer.data : []).map((item) => item?.attributes).filter((trade) => trade && !trade.is_anomalous)
    .map((trade) => {
      const outgoing = String(trade.from_token_address ?? "").toLowerCase() === own; // the coin was sold
      const time = Date.parse(trade.block_timestamp);
      return {
        time: Number.isFinite(time) ? time : null, kind: outgoing ? "sell" : "buy",
        price: number(outgoing ? trade.price_from_in_usd : trade.price_to_in_usd), usd: number(trade.volume_in_usd),
        amount: number(outgoing ? trade.from_token_amount : trade.to_token_amount),
        maker: text(trade.tx_from_address, 80) || null, tx: text(trade.tx_hash, 100) || null,
      };
    })
    .filter((trade) => trade.time && trade.usd !== null && trade.amount !== null).slice(0, 300);
}

export function createTrades({ get, now = Date.now, perMinute = 25 } = {}) {
  const cache = new Map();
  const pending = new Map();
  let used = [];
  async function cached(key, ttl, load) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value;
    if (pending.has(key)) return pending.get(key);
    used = used.filter((at) => now() - at < 60_000);
    if (used.length >= perMinute) {
      if (hit) return hit.value;
      throw Object.assign(new Error("busy, try again in a minute"), { status: 503 });
    }
    used.push(now());
    const job = (async () => {
      try {
        const value = await load();
        cache.set(key, { at: now(), value });
        if (cache.size > 2_000) cache.delete(cache.keys().next().value);
        return value;
      } catch (error) {
        if (hit) return hit.value;
        throw error;
      }
    })();
    pending.set(key, job);
    try { return await job; } finally { pending.delete(key); }
  }

  async function trades(network, token) {
    const pool = await cached(`pool:${network}:${token.toLowerCase()}`, 3_600_000,
      async () => choosePool(await get(`${API}/networks/${network}/tokens/${token}/pools?page=1`), network, token));
    if (!pool) return { pool: null, trades: [], buys: 0, sells: 0 };
    const list = await cached(`trades:${network}:${pool.address}`, 15_000,
      async () => readTrades(await get(`${API}/networks/${network}/pools/${pool.address}/trades`), token));
    const sum = (kind) => list.filter((trade) => trade.kind === kind).reduce((total, trade) => total + trade.usd, 0);
    return { pool, trades: list, buys: sum("buy"), sells: sum("sell") };
  }

  // Answers GET /market/trades, or returns false.
  async function handle(request, response, url) {
    if (url.pathname !== "/market/trades") return false;
    const send = (status, body, maxAge = 10) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": status === 200 ? `public, max-age=${maxAge}` : "no-store" });
      response.end(JSON.stringify(body));
      return true;
    };
    if (request.method !== "GET") return send(405, { error: "read only" });
    const network = url.searchParams.get("network") ?? "";
    const token = url.searchParams.get("token") ?? "";
    if (!NETWORK.test(network) || !TOKEN.test(token)) return send(400, { error: "a network and a token contract, please" });
    try {
      return send(200, await trades(network, token));
    } catch (error) {
      return send(error?.status === 503 ? 503 : 502, { error: "trades are unavailable, try again in a minute" });
    }
  }
  return { handle, trades };
}
