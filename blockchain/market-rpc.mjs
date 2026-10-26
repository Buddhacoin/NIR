// More networks for the explorer (market-chain.mjs), read straight from free
// public JSON-RPC nodes, with no explorer and no key: what an address holds
// (the network coin and the listed tokens, in one Multicall3 call), its
// token transfers over the last 50,000 blocks, and the newest transfers of
// the largest tokens for the feed.
//
// Which tokens count: the top coins by market cap (CoinGecko) that have a
// contract on the network, with their prices; decimals are read from the
// contracts once. Plain coin transfers are not visible without an explorer,
// so wallets on these networks show token transfers only.

const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const COINGECKO = "https://api.coingecko.com/api/v3";
// The networks, their public nodes, CoinGecko's platform names, and how to price the network coin.
// `logs` and `range`: the free node that answers a wallet's log queries, and the most blocks it takes in one.
export const NODES = {
  base: { rpc: "https://base-rpc.publicnode.com", platform: "base", native: { symbol: "ETH" }, blockSeconds: 2, range: 49_000 },
  arbitrum: { rpc: "https://arbitrum-one-rpc.publicnode.com", logs: "https://arb1.arbitrum.io/rpc", platform: "arbitrum-one", native: { symbol: "ETH" }, blockSeconds: 0.25, range: 99_000 },
  polygon: { rpc: "https://polygon-bor-rpc.publicnode.com", platform: "polygon-pos", native: { symbol: "POL" }, blockSeconds: 2, range: 9_999 },
  bsc: { rpc: "https://bsc-rpc.publicnode.com", platform: "binance-smart-chain", native: { coin: "binancecoin" }, blockSeconds: 0.75, range: 9_999 },
};
// Networks whose explorer reads a wallet's tokens, with a public node to read the listed ones from when
// the explorer is too slow (a wallet with thousands of tokens can take it minutes).
export const BACKUP = {
  // CoinGecko's platform for each is found by the network's chain id (/asset_platforms).
  eth: { rpc: "https://eth.drpc.org", chainId: 1 },
  optimism: { rpc: "https://mainnet.optimism.io", chainId: 10 },
};
const RANGE = 49_000; // the default widest log query
const BATCH = 5; // contracts per log query; the public nodes turn larger ones away

// --- ABI: just enough for Multicall3's aggregate3 and the ERC-20 reads.
const word = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
const addressWord = (address) => word(address.toLowerCase());
const uint = (value) => word(value.toString(16));
export function encodeAggregate3(calls) {
  const heads = [];
  const tails = [];
  let offset = calls.length * 32;
  for (const { target, data } of calls) {
    const body = data.replace(/^0x/, "");
    const padded = body.padEnd(Math.ceil(body.length / 64) * 64, "0");
    const tuple = addressWord(target) + uint(1) + uint(96) + uint(body.length / 2) + padded;
    heads.push(uint(offset));
    tails.push(tuple);
    offset += tuple.length / 2;
  }
  return `0x82ad56cb${uint(32)}${uint(calls.length)}${heads.join("")}${tails.join("")}`;
}
export function decodeAggregate3(hex) {
  const data = hex.replace(/^0x/, "");
  const at = (byte) => BigInt(`0x${data.slice(byte * 2, byte * 2 + 64) || "0"}`);
  const start = Number(at(0));
  const count = Number(at(start));
  const results = [];
  for (let index = 0; index < count; index += 1) {
    const tuple = start + 32 + Number(at(start + 32 + index * 32));
    const success = at(tuple) === 1n;
    const body = tuple + Number(at(tuple + 32));
    const length = Number(at(body));
    results.push({ success, data: `0x${data.slice((body + 32) * 2, (body + 32 + length) * 2)}` });
  }
  return results;
}
const balanceOf = (address) => `0x70a08231${addressWord(address)}`;
const nativeBalance = (address) => `0x4d2301cc${addressWord(address)}`; // Multicall3.getEthBalance
const DECIMALS = "0x313ce567";
const toNumber = (hex, decimals) => {
  const value = BigInt(hex && hex !== "0x" ? hex : "0x0");
  return Number(value) / 10 ** decimals;
};

// One request at a time per node, a little apart: the free nodes block bursts for a while.
const queues = new Map();
function queued(url, job) {
  const host = new URL(url).host;
  const run = (queues.get(host) ?? Promise.resolve()).then(job, job);
  queues.set(host, run.catch(() => {}).then(() => new Promise((resolve) => { setTimeout(resolve, 120); })));
  return run;
}
// A node that turns a request away (403, 429: too many at once) gets two more tries, a little later each.
export async function postRpc(url, method, params) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await queued(url, () => sendRpc(url, method, params));
    } catch (error) {
      if (attempt >= 2 || !/answered (?:403|429|5\d\d)/.test(error.message)) throw error;
      await new Promise((resolve) => { setTimeout(resolve, 1500 * (attempt + 1)); });
    }
  }
}
async function sendRpc(url, method, params) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "NIR-Markets/1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  const answer = await response.json();
  if (answer.error) throw new Error(`${new URL(url).host}: ${String(answer.error.message).slice(0, 120)}`);
  return answer.result;
}

export function createNodes({ rpc = postRpc, get, cached }) {
  const decimals = new Map(); // "chain:contract" → decimals
  let ids = null; // contract and symbol → CoinGecko id, filled with the token lists
  // The listed tokens of every network: top coins with a contract there, with price and decimals.
  async function tokens() {
    return cached("rpc:tokens", 300_000, async () => {
      // The 1,000 largest coins (a later page may fail on a busy minute; the first is enough then).
      const page = (number) => get(`${COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${number}`);
      // The coin list and the networks' platform names change slowly: both are kept a day.
      const [{ list, platforms }, markets, ...more] = await Promise.all([
        cached("rpc:coin-list", 86_400_000, async () => {
          const [coins, known] = await Promise.all([get(`${COINGECKO}/coins/list?include_platform=true`), get(`${COINGECKO}/asset_platforms`).catch(() => [])]);
          return { list: coins, platforms: known };
        }),
        page(1), ...[2, 3, 4].map((number) => page(number).catch(() => [])),
      ]);
      const byId = new Map([markets, ...more].flatMap((answer) => (Array.isArray(answer) ? answer : [])).map((coin) => [coin.id, coin]));
      const result = {};
      const platformOf = (node) => node.platform ?? (Array.isArray(platforms) ? platforms : []).find((item) => item?.chain_identifier === node.chainId)?.id;
      for (const [chain, setup] of Object.entries({ ...NODES, ...BACKUP })) {
        const node = { ...setup, platform: platformOf(setup) };
        if (!node.platform) continue;
        const listed = (Array.isArray(list) ? list : []).filter((coin) => byId.has(coin.id) && /^0x[0-9a-fA-F]{40}$/.test(coin.platforms?.[node.platform] ?? ""))
          .map((coin) => { const market = byId.get(coin.id); return { address: coin.platforms[node.platform].toLowerCase(), symbol: String(market.symbol ?? "").toUpperCase().slice(0, 20),
            name: String(market.name ?? "").slice(0, 60), icon: /^https:\/\/(?:coin-images|assets)\.coingecko\.com\//.test(market.image ?? "") ? market.image : null,
            price: Number.isFinite(market.current_price) ? market.current_price : null, cap: market.market_cap ?? 0 }; })
          .sort((left, right) => right.cap - left.cap).slice(0, 1000);
        // Decimals never change: each contract is asked once.
        const missing = listed.filter((item) => !decimals.has(`${chain}:${item.address}`));
        if (missing.length) {
          try {
            const answers = decodeAggregate3(await rpc(node.rpc, "eth_call", [{ to: MULTICALL, data: encodeAggregate3(missing.map((item) => ({ target: item.address, data: DECIMALS }))) }, "latest"]));
            missing.forEach((item, index) => { if (answers[index]?.success && answers[index].data.length > 2) decimals.set(`${chain}:${item.address}`, Number(BigInt(answers[index].data))); });
          } catch {}
        }
        const nativeCoin = !node.native ? null : node.native.coin ? byId.get(node.native.coin) : [...byId.values()].find((coin) => String(coin.symbol).toUpperCase() === node.native.symbol);
        result[chain] = {
          native: { address: null, symbol: String(nativeCoin?.symbol ?? node.native?.symbol ?? "").toUpperCase(), name: String(nativeCoin?.name ?? ""),
            icon: /^https:\/\/(?:coin-images|assets)\.coingecko\.com\//.test(nativeCoin?.image ?? "") ? nativeCoin.image : null,
            price: Number.isFinite(nativeCoin?.current_price) ? nativeCoin.current_price : null },
          tokens: listed.filter((item) => (decimals.get(`${chain}:${item.address}`) ?? 99) <= 36).map((item) => ({ ...item, decimals: decimals.get(`${chain}:${item.address}`) })),
        };
      }
      // Every coin's contract on every network, and the top coins by symbol, for links to coin pages.
      ids = { contract: new Map(), symbol: new Map(), image: new Map() };
      for (const coin of Array.isArray(list) ? list : []) {
        for (const address of Object.values(coin.platforms ?? {})) {
          if (/^0x[0-9a-fA-F]{40}$/.test(address ?? "") && !ids.contract.has(address.toLowerCase())) ids.contract.set(address.toLowerCase(), coin.id);
        }
      }
      for (const coin of byId.values()) {
        const symbol = String(coin.symbol ?? "").toUpperCase();
        if (symbol && !ids.symbol.has(symbol)) ids.symbol.set(symbol, coin.id);
        // Each of the largest coins' logo, for tokens whose source brings none.
        if (/^https:\/\/(?:coin-images|assets)\.coingecko\.com\//.test(coin.image ?? "")) ids.image.set(coin.id, coin.image);
      }
      return result;
      // Kept while a refresh runs: the lists change slowly, and a slow refresh must not hold up a page.
    }, { stale: true });
  }
  const tokenAt = (list, address) => list.tokens.find((item) => item.address === address.toLowerCase());
  const coinOf = (item) => ({ address: item.address, symbol: item.symbol, name: item.name, icon: item.icon, price: item.price });

  // What an address holds on every node network: the coin and every listed token, one call per network.
  async function holdings(address) {
    const listed = await tokens();
    return Promise.all(Object.entries(NODES).map(async ([chain, node]) => {
      try {
        const list = listed[chain];
        const calls = [{ target: MULTICALL, data: nativeBalance(address) }, ...list.tokens.map((item) => ({ target: item.address, data: balanceOf(address) }))];
        const [answers, sent] = await Promise.all([rpc(node.rpc, "eth_call", [{ to: MULTICALL, data: encodeAggregate3(calls) }, "latest"]).then(decodeAggregate3),
          rpc(node.rpc, "eth_getTransactionCount", [address, "latest"]).then((count) => Number(count) || 0).catch(() => 0)]);
        const assets = [];
        const native = answers[0]?.success ? toNumber(answers[0].data, 18) : 0;
        if (native > 0) assets.push({ chain, token: list.native, amount: native, usd: list.native.price === null ? null : native * list.native.price });
        list.tokens.forEach((item, index) => {
          const answer = answers[index + 1];
          if (!answer?.success) return;
          const amount = toNumber(answer.data, item.decimals);
          // A network coin's own token contract (0x…1010 and the like) repeats the coin balance.
          if (/^0x0{30,}/.test(item.address)) return;
          if (amount > 0 && item.price !== null && amount * item.price >= 0.01) assets.push({ chain, token: coinOf(item), amount, usd: amount * item.price });
        });
        return { chain, ok: true, partial: false, info: null, assets, sent, active: sent > 0 || assets.length > 0 };
      } catch {
        return { chain, ok: false, partial: false, info: null, assets: [] };
      }
    }));
  }

  // The listed tokens an address holds on an explorer network, read from its public node in one call.
  async function listedTokens(chain, address) {
    const list = (await tokens())[chain];
    if (!BACKUP[chain] || !list?.tokens.length) return [];
    const answers = decodeAggregate3(await rpc(BACKUP[chain].rpc, "eth_call", [{ to: MULTICALL, data: encodeAggregate3(list.tokens.map((item) => ({ target: item.address, data: balanceOf(address) }))) }, "latest"]));
    const assets = [];
    list.tokens.forEach((item, index) => {
      const answer = answers[index];
      if (!answer?.success) return;
      const amount = toNumber(answer.data, item.decimals);
      if (amount > 0 && item.price !== null && amount * item.price >= 0.01) assets.push({ chain, token: coinOf(item), amount, usd: amount * item.price });
    });
    return assets;
  }

  // Token transfers of the listed tokens: an address's own (in, out or both) or the network's newest.
  function transfer(chain, list, log, time) {
    const item = tokenAt(list, log.address);
    if (!item || log.topics?.length !== 3) return null;
    const amount = toNumber(log.data, item.decimals);
    if (!amount) return null;
    const side = (topic) => ({ address: `0x${topic.slice(26)}`, name: null, tags: [], contract: false });
    return { id: `${chain}:${log.transactionHash}:${Number(log.logIndex)}`, chain, hash: log.transactionHash, time,
      from: side(log.topics[1]), to: side(log.topics[2]), token: coinOf(item), amount, usd: item.price === null ? null : amount * item.price };
  }
  async function latest(node) {
    const block = await rpc(node.rpc, "eth_getBlockByNumber", ["latest", false]);
    return { number: Number(block.number), time: Number(block.timestamp) * 1000 };
  }
  const timeOf = (head, node, number) => head.time - (head.number - number) * node.blockSeconds * 1000;
  // A page goes back from `before` (the newest block when absent) window by
  // window, until it holds twenty transfers or has read eight windows. The first
  // window is small and each next one four times wider, so a busy wallet answers
  // fast and a quiet one still reaches back. After ten seconds the page ends
  // with what it has.
  async function addressTransfers(address, chain, direction, before = null) {
    const node = NODES[chain];
    const list = (await tokens())[chain];
    const head = await latest(node);
    const padded = `0x${addressWord(address)}`;
    // The ten largest tokens, five contracts a query, each way.
    const batches = [list.tokens.slice(0, BATCH), list.tokens.slice(BATCH, BATCH * 2)].filter((batch) => batch.length);
    let top = Math.min(head.number, Number.isSafeInteger(before) && before > 0 ? before : head.number);
    const logs = [];
    const widest = node.range ?? RANGE;
    let span = Math.min(widest, 600);
    const started = Date.now();
    for (let window = 0; window < 8 && top > 0 && logs.length < 20 && (window === 0 || Date.now() - started < 10_000); window += 1, span = Math.min(widest, span * 4)) {
      const range = { fromBlock: `0x${Math.max(0, top - span).toString(16)}`, toBlock: `0x${top.toString(16)}` };
      const query = (topics) => Promise.all(batches.map((batch) => rpc(node.logs ?? node.rpc, "eth_getLogs", [{ ...range, address: batch.map((item) => item.address), topics }])))
        .then((lists) => lists.flat());
      let found;
      try {
        found = await Promise.all([
          direction === "in" ? [] : query([TRANSFER, padded]),
          direction === "out" ? [] : query([TRANSFER, null, padded]),
        ]);
      } catch (error) {
        // A refused window ends the page early; the next page starts from it again.
        if (window === 0) throw error;
        break;
      }
      logs.push(...found.flat());
      top = Math.max(0, top - span - 1);
    }
    // Two hundred at most: a busier stretch carries on from the last block shown.
    logs.sort((left, right) => Number(right.blockNumber) - Number(left.blockNumber));
    if (logs.length > 200) top = Number(logs[199].blockNumber) - 1;
    const items = logs.slice(0, 200).map((log) => transfer(chain, list, log, timeOf(head, node, Number(log.blockNumber)))).filter(Boolean);
    return { items, next: top > 0 ? { before: top } : null, reached: timeOf(head, node, top) };
  }
  // The newest transfers of each network's five largest tokens, over its last few seconds.
  async function feed() {
    const listed = await tokens();
    const lists = await Promise.all(Object.entries(NODES).map(async ([chain, node]) => {
      try {
        const list = listed[chain];
        const head = await latest(node);
        const span = Math.max(2, Math.round(8 / node.blockSeconds));
        const logs = await rpc(node.rpc, "eth_getLogs", [{ fromBlock: `0x${(head.number - span).toString(16)}`, toBlock: `0x${head.number.toString(16)}`,
          address: list.tokens.slice(0, BATCH).map((item) => item.address), topics: [TRANSFER] }]);
        return logs.slice(-120).map((log) => transfer(chain, list, log, timeOf(head, node, Number(log.blockNumber)))).filter(Boolean);
      } catch {
        return [];
      }
    }));
    return lists.flat();
  }

  const coinIds = async () => { await tokens(); return ids; };
  return { holdings, listedTokens, addressTransfers, feed, tokens, coinIds, networks: Object.keys(NODES) };
}
