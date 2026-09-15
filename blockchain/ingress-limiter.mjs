export class IngressLimiter {
  #capacity;
  #entries = new Map();
  #maxKeys;
  #refillPerMs;

  constructor({ capacity = 20, maxKeys = 1_024, refillPerMinute = 20 } = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000 ||
        !Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 1_000_000 ||
        !Number.isFinite(refillPerMinute) || refillPerMinute <= 0 || refillPerMinute > 10_000) {
      throw new Error("ingress limiter configuration is invalid");
    }
    this.#capacity = capacity;
    this.#maxKeys = maxKeys;
    this.#refillPerMs = refillPerMinute / 60_000;
  }

  consume(key, now = Date.now(), cost = 1) {
    if (typeof key !== "string" || key.length < 1 || key.length > 256 ||
        !Number.isFinite(now) || !Number.isFinite(cost) || cost <= 0 || cost > this.#capacity) {
      throw new Error("ingress request identity or cost is invalid");
    }
    const existing = this.#entries.get(key);
    const elapsed = existing ? Math.max(0, now - existing.updatedAt) : 0;
    const tokens = existing
      ? Math.min(this.#capacity, existing.tokens + elapsed * this.#refillPerMs)
      : this.#capacity;
    if (tokens < cost) throw new Error("request rate limit exceeded");
    this.#entries.delete(key);
    this.#entries.set(key, { tokens: tokens - cost, updatedAt: now });
    while (this.#entries.size > this.#maxKeys) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
    return Math.floor(tokens - cost);
  }

  get size() { return this.#entries.size; }
}
