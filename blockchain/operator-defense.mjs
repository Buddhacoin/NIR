const IDENTITY = /^[A-Za-z0-9:._-]{1,256}$/;

function validatedIdentity(identity) {
  if (typeof identity !== "string" || !IDENTITY.test(identity)) {
    throw new Error("operator identity is invalid");
  }
  return identity;
}

function defaultScheduler() {
  return {
    clearTimeout: (handle) => clearTimeout(handle),
    setTimeout: (callback, delay) => {
      const handle = setTimeout(callback, delay);
      handle.unref?.();
      return handle;
    },
  };
}

export async function boundedAllSettled(items, worker, maximum = 8) {
  if (!Array.isArray(items) || typeof worker !== "function" ||
      !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 128) {
    throw new Error("bounded fanout input is invalid");
  }
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(maximum, items.length) }, run));
  return results;
}

export class ReplayNonceCache {
  #clock;
  #entries = new Map();
  #handle = null;
  #maxEntries;
  #scheduler;
  #ttlMs;

  constructor({
    clock = () => Date.now(),
    maxEntries = 4_096,
    scheduler = defaultScheduler(),
    ttlMs = 60_000,
  } = {}) {
    if (typeof clock !== "function" || typeof scheduler?.setTimeout !== "function" ||
        typeof scheduler?.clearTimeout !== "function" || !Number.isSafeInteger(maxEntries) ||
        maxEntries < 16 || maxEntries > 1_000_000 || !Number.isSafeInteger(ttlMs) ||
        ttlMs < 1_000 || ttlMs > 3_600_000) {
      throw new Error("replay nonce cache configuration is invalid");
    }
    this.#clock = clock;
    this.#maxEntries = maxEntries;
    this.#scheduler = scheduler;
    this.#ttlMs = ttlMs;
    this.#scheduleCleanup();
  }

  #scheduleCleanup() {
    this.#handle = this.#scheduler.setTimeout(() => {
      this.#handle = null;
      this.cleanup(this.#clock());
      this.#scheduleCleanup();
    }, Math.max(250, Math.floor(this.#ttlMs / 2)));
  }

  cleanup(now = this.#clock()) {
    for (const [nonce, expiresAt] of this.#entries) {
      if (expiresAt <= now) this.#entries.delete(nonce);
    }
  }

  has(nonce) {
    const expiresAt = this.#entries.get(nonce);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.#clock()) {
      this.#entries.delete(nonce);
      return false;
    }
    return true;
  }

  set(nonce, observedAt = this.#clock()) {
    this.cleanup(observedAt);
    if (!this.#entries.has(nonce) && this.#entries.size >= this.#maxEntries) {
      throw new Error("replay nonce capacity exceeded");
    }
    this.#entries.set(nonce, observedAt + this.#ttlMs);
    return this;
  }

  delete(nonce) { return this.#entries.delete(nonce); }
  get size() { return this.#entries.size; }
  [Symbol.iterator]() { return this.#entries[Symbol.iterator](); }

  close() {
    if (this.#handle !== null) this.#scheduler.clearTimeout(this.#handle);
    this.#handle = null;
    this.#entries.clear();
  }
}

export class PeerReputation {
  #clock;
  #decayMs;
  #entries = new Map();
  #maxEntries;
  #maxStrikes;
  #quarantineMs;
  #threshold;
  #totals = { quarantines: 0, recoveries: 0, violations: 0 };

  constructor({
    clock = () => Date.now(),
    decayMs = 60_000,
    maxEntries = 1_024,
    maxStrikes = 16,
    quarantineMs = 120_000,
    threshold = 4,
  } = {}) {
    if (typeof clock !== "function" || !Number.isSafeInteger(decayMs) || decayMs < 1_000 ||
        !Number.isSafeInteger(maxEntries) || maxEntries < 4 || maxEntries > 1_000_000 ||
        !Number.isSafeInteger(maxStrikes) || maxStrikes < 1 || maxStrikes > 1_000 ||
        !Number.isSafeInteger(quarantineMs) || quarantineMs < 1_000 ||
        !Number.isSafeInteger(threshold) || threshold < 1 || threshold > maxStrikes) {
      throw new Error("peer reputation configuration is invalid");
    }
    this.#clock = clock;
    this.#decayMs = decayMs;
    this.#maxEntries = maxEntries;
    this.#maxStrikes = maxStrikes;
    this.#quarantineMs = quarantineMs;
    this.#threshold = threshold;
  }

  #current(identity, now) {
    const previous = this.#entries.get(identity) ?? {
      lastUpdated: now, quarantineUntil: 0, strikes: 0,
    };
    const elapsedSteps = Math.floor(Math.max(0, now - previous.lastUpdated) / this.#decayMs);
    const current = {
      lastUpdated: elapsedSteps > 0 ? previous.lastUpdated + elapsedSteps * this.#decayMs
        : previous.lastUpdated,
      quarantineUntil: previous.quarantineUntil,
      strikes: Math.max(0, previous.strikes - elapsedSteps),
    };
    if (current.quarantineUntil > 0 && current.quarantineUntil <= now) {
      current.quarantineUntil = 0;
      current.strikes = Math.min(current.strikes, this.#threshold - 1);
      this.#totals.recoveries += 1;
    }
    return current;
  }

  #store(identity, entry) {
    this.#entries.delete(identity);
    this.#entries.set(identity, entry);
    while (this.#entries.size > this.#maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
  }

  assertAllowed(identity, now = this.#clock()) {
    validatedIdentity(identity);
    const entry = this.#current(identity, now);
    this.#store(identity, entry);
    if (entry.quarantineUntil > now) throw new Error("authenticated peer is quarantined");
  }

  recordViolation(identity, reason, now = this.#clock()) {
    validatedIdentity(identity);
    if (typeof reason !== "string" || reason.length < 1 || reason.length > 80) {
      throw new Error("peer violation reason is invalid");
    }
    const entry = this.#current(identity, now);
    entry.lastUpdated = now;
    entry.strikes = Math.min(this.#maxStrikes, entry.strikes + 1);
    this.#totals.violations += 1;
    if (entry.strikes >= this.#threshold && entry.quarantineUntil <= now) {
      entry.quarantineUntil = now + this.#quarantineMs;
      this.#totals.quarantines += 1;
    }
    this.#store(identity, entry);
    return { quarantined: entry.quarantineUntil > now, strikes: entry.strikes };
  }

  metrics(now = this.#clock()) {
    let quarantinedPeers = 0;
    for (const identity of [...this.#entries.keys()]) {
      const entry = this.#current(identity, now);
      this.#store(identity, entry);
      if (entry.quarantineUntil > now) quarantinedPeers += 1;
    }
    return { ...this.#totals, knownPeers: this.#entries.size, quarantinedPeers };
  }
}

export class VerificationScheduler {
  #active = 0;
  #activeByIdentity = new Map();
  #clock;
  #cursor = 0;
  #maxConcurrent;
  #maxPerIdentity;
  #maxQueued;
  #maxQueuedPerIdentity;
  #order = [];
  #queueTimeoutMs;
  #queues = new Map();
  #scheduler;
  #totals = { completed: 0, queueRejected: 0, queueTimedOut: 0, started: 0 };

  constructor({
    clock = () => Date.now(),
    maxConcurrent = 8,
    maxPerIdentity = 2,
    maxQueued = 128,
    maxQueuedPerIdentity = 16,
    queueTimeoutMs = 3_000,
    scheduler = defaultScheduler(),
  } = {}) {
    if (typeof clock !== "function" || typeof scheduler?.setTimeout !== "function" ||
        typeof scheduler?.clearTimeout !== "function" ||
        !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 1_024 ||
        !Number.isSafeInteger(maxPerIdentity) || maxPerIdentity < 1 ||
        maxPerIdentity > maxConcurrent || !Number.isSafeInteger(maxQueued) || maxQueued < 1 ||
        !Number.isSafeInteger(maxQueuedPerIdentity) || maxQueuedPerIdentity < 1 ||
        maxQueuedPerIdentity > maxQueued || !Number.isSafeInteger(queueTimeoutMs) ||
        queueTimeoutMs < 1 || queueTimeoutMs > 60_000) {
      throw new Error("verification scheduler configuration is invalid");
    }
    this.#clock = clock;
    this.#maxConcurrent = maxConcurrent;
    this.#maxPerIdentity = maxPerIdentity;
    this.#maxQueued = maxQueued;
    this.#maxQueuedPerIdentity = maxQueuedPerIdentity;
    this.#queueTimeoutMs = queueTimeoutMs;
    this.#scheduler = scheduler;
  }

  get #queued() {
    return [...this.#queues.values()].reduce((total, queue) => total + queue.length, 0);
  }

  run(identity, task) {
    validatedIdentity(identity);
    if (typeof task !== "function") return Promise.reject(new Error("verification task is invalid"));
    const queue = this.#queues.get(identity) ?? [];
    if (this.#queued >= this.#maxQueued || queue.length >= this.#maxQueuedPerIdentity) {
      this.#totals.queueRejected += 1;
      return Promise.reject(new Error("verification queue is full"));
    }
    return new Promise((resolve, reject) => {
      const job = { enqueuedAt: this.#clock(), handle: null, reject, resolve, task };
      job.handle = this.#scheduler.setTimeout(() => {
        const pending = this.#queues.get(identity);
        const index = pending?.indexOf(job) ?? -1;
        if (index >= 0) {
          pending.splice(index, 1);
          this.#totals.queueTimedOut += 1;
          reject(new Error("verification queue timeout"));
          this.#compact(identity);
        }
      }, this.#queueTimeoutMs);
      queue.push(job);
      if (!this.#queues.has(identity)) {
        this.#queues.set(identity, queue);
        this.#order.push(identity);
      }
      this.#drain();
    });
  }

  #compact(identity) {
    if ((this.#queues.get(identity)?.length ?? 0) > 0) return;
    this.#queues.delete(identity);
    const index = this.#order.indexOf(identity);
    if (index >= 0) {
      this.#order.splice(index, 1);
      if (this.#order.length === 0) this.#cursor = 0;
      else if (this.#cursor >= this.#order.length) this.#cursor %= this.#order.length;
    }
  }

  #nextIdentity() {
    if (this.#order.length === 0) return null;
    for (let attempts = 0; attempts < this.#order.length; attempts += 1) {
      if (this.#cursor >= this.#order.length) this.#cursor = 0;
      const identity = this.#order[this.#cursor];
      this.#cursor = (this.#cursor + 1) % this.#order.length;
      if ((this.#queues.get(identity)?.length ?? 0) > 0 &&
          (this.#activeByIdentity.get(identity) ?? 0) < this.#maxPerIdentity) return identity;
    }
    return null;
  }

  #drain() {
    while (this.#active < this.#maxConcurrent) {
      const identity = this.#nextIdentity();
      if (identity === null) return;
      const queue = this.#queues.get(identity);
      const job = queue.shift();
      this.#scheduler.clearTimeout(job.handle);
      this.#compact(identity);
      this.#active += 1;
      this.#activeByIdentity.set(identity, (this.#activeByIdentity.get(identity) ?? 0) + 1);
      this.#totals.started += 1;
      Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => {
        this.#active -= 1;
        const active = (this.#activeByIdentity.get(identity) ?? 1) - 1;
        if (active === 0) this.#activeByIdentity.delete(identity);
        else this.#activeByIdentity.set(identity, active);
        this.#totals.completed += 1;
        this.#drain();
      });
    }
  }

  metrics() {
    return {
      ...this.#totals,
      active: this.#active,
      activeIdentities: this.#activeByIdentity.size,
      queued: this.#queued,
      queuedIdentities: this.#queues.size,
    };
  }
}
