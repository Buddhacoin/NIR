const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const ATOMIC = /^(0|[1-9][0-9]{0,31})$/;

export function parseObserverSettings({ url, token, networkId, genesisHash }) {
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error("Нужен адрес локального наблюдателя"); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" ||
      !parsed.port || parsed.username || parsed.password || parsed.pathname !== "/" ||
      parsed.search || parsed.hash) {
    throw new Error("Наблюдатель должен работать на 127.0.0.1");
  }
  if (!TOKEN.test(token)) throw new Error("Неверный токен наблюдателя");
  if (typeof networkId !== "string" || networkId.length < 3 || networkId.length > 128 ||
      !HASH.test(genesisHash)) {
    throw new Error("Проверьте идентификатор сети и genesis");
  }
  return { url: parsed.origin, token, networkId, genesisHash };
}

export function checkedObserverBalance(result, settings, address) {
  const statement = result?.statement;
  if (!ADDRESS.test(address) || result?.verified !== true || result.address !== address ||
      result.networkId !== settings.networkId || result.genesisHash !== settings.genesisHash ||
      statement?.networkId !== settings.networkId || statement?.account?.address !== address ||
      !Number.isSafeInteger(statement?.height) || statement.height < 1 ||
      !HASH.test(statement?.tipHash ?? "") || !ATOMIC.test(statement?.account?.atomicBalance ?? "")) {
    throw new Error("Доказательство баланса не совпадает с адресом или сетью");
  }
  return { atomicBalance: statement.account.atomicBalance, height: statement.height };
}

export function formatAtomicBalance(value) {
  if (!ATOMIC.test(value)) throw new Error("Доказательство баланса не совпадает с адресом или сетью");
  const atomic = BigInt(value);
  return `${atomic / 100_000_000n}.${(atomic % 100_000_000n).toString().padStart(8, "0")}`;
}

export async function refreshObserverAccount(settings, address, fetcher = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetcher(`${settings.url}/v1/refresh-account`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-nir-observer-token": settings.token },
      body: "{}",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Локальный наблюдатель не подтвердил баланс");
    return checkedObserverBalance(await response.json(), settings, address);
  } catch {
    throw new Error("Локальный наблюдатель не подтвердил баланс");
  } finally {
    clearTimeout(timeout);
  }
}
