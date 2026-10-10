import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createOpenModelCatalog } from "../blockchain/open-model-catalog.mjs";
import { createMiningPracticeApp } from "../blockchain/mining-practice-app.mjs";

const qwen = "Qwen/Qwen3-0.6B";
const tiny = "TinyLlama/TinyLlama-1.1B-Chat-v1.0";
const shaA = "a".repeat(40);
const shaB = "b".repeat(40);
const shaC = "c".repeat(40);

function metadata(repo, sha = shaA, overrides = {}) {
  return new Response(JSON.stringify({ id: repo, sha, private: false, gated: false, ...overrides }), {
    headers: { "Content-Type": "application/json" },
  });
}

test("catalog only fetches two fixed public repos and records immutable revision identities", async () => {
  const calls = [];
  let current = shaA;
  let now = 1_000_000;
  const catalog = createOpenModelCatalog({
    now: () => now,
    fetchMetadata: async (url, options) => {
      calls.push({ url, options });
      const repo = url.includes(qwen) ? qwen : tiny;
      return metadata(repo, current);
    },
  });
  const first = await catalog.get();
  assert.equal(first.entries.length, 2);
  assert.deepEqual(first.entries.map((entry) => entry.versions), [[shaA], [shaA]]);
  assert.equal(first.rewardEligible, false);
  assert.equal(first.runnableRepo, null);
  assert.equal(first.stale, false);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ url, options }) =>
    /^https:\/\/huggingface\.co\/api\/models\/(?:Qwen\/Qwen3-0\.6B|TinyLlama\/TinyLlama-1\.1B-Chat-v1\.0)\?expand=sha&expand=private&expand=gated$/.test(url) &&
    options.redirect === "manual" && options.credentials === "omit"));
  await catalog.get();
  assert.equal(calls.length, 2, "fresh metadata is cached");
  current = shaB;
  now += 300_001;
  const updated = await catalog.get();
  assert.deepEqual(updated.entries.map((entry) => entry.versions), [[shaA, shaB], [shaA, shaB]],
    "new alias target adds a version but does not rewrite the earlier SHA");
});

test("invalid and hostile remote metadata cannot become selectable", async () => {
  const invalids = [
    () => new Response("{", { headers: { "Content-Type": "application/json" } }),
    () => new Response("{}", { headers: { "Content-Type": "text/html" } }),
    () => new Response(JSON.stringify({ id: "wrong/repo", sha: shaA, private: false, gated: false }), { headers: { "Content-Type": "application/json" } }),
    () => metadata(qwen, "../main"),
    () => metadata(qwen, shaA, { gated: "manual" }),
    () => metadata(qwen, shaA, { private: true }),
    () => new Response(" ".repeat(33 * 1024), { headers: { "Content-Type": "application/json" } }),
    () => new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "999999" } }),
    () => new Response("{}", { status: 302, headers: { "Content-Type": "application/json", Location: "http://127.0.0.1/" } }),
  ];
  for (const invalid of invalids) {
    const catalog = createOpenModelCatalog({ fetchMetadata: async () => invalid() });
    const state = await catalog.get();
    assert.equal(state.stale, true);
    assert.ok(state.entries.every((entry) => entry.versions.length === 0));
  }
});

test("failed refresh preserves prior exact SHA and marks it stale", async () => {
  let online = true;
  let now = 1_000_000;
  const catalog = createOpenModelCatalog({
    now: () => now,
    fetchMetadata: async (url) => {
      if (!online) throw new Error("network offline");
      return metadata(url.includes(qwen) ? qwen : tiny);
    },
  });
  await catalog.get();
  online = false;
  now += 30_001;
  const stale = await catalog.refresh();
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.entries.map((entry) => entry.versions), [[shaA], [shaA]]);
});

test("manual refresh is rate limited even when the caller repeats it", async () => {
  let calls = 0;
  let now = 1_000_000;
  const catalog = createOpenModelCatalog({ now: () => now,
    fetchMetadata: async (url) => { calls++; return metadata(url.includes(qwen) ? qwen : tiny); },
  });
  await catalog.refresh();
  await Promise.all(Array.from({ length: 20 }, () => catalog.refresh()));
  assert.equal(calls, 2);
  now += 30_000;
  await catalog.refresh();
  assert.equal(calls, 4);
});

test("observed revision history is bounded without rewriting earlier SHAs", async () => {
  let sequence = 0;
  let now = 1_000_000;
  const catalog = createOpenModelCatalog({ now: () => now,
    fetchMetadata: async (url) => metadata(url.includes(qwen) ? qwen : tiny,
      String(sequence).padStart(40, "0")),
  });
  for (sequence = 0; sequence < 20; sequence++) {
    await catalog.refresh();
    now += 30_001;
  }
  const versions = catalog.snapshot().entries[0].versions;
  assert.equal(versions.length, 12);
  assert.equal(versions[0], String(8).padStart(40, "0"));
  assert.equal(versions.at(-1), String(19).padStart(40, "0"));
});

test("local catalog endpoints expose only validated metadata and refuse cross-origin refresh", async () => {
  let refreshes = 0;
  const catalog = { get: async () => ({ status: "read-only-open-model-catalog", entries: [] }),
    refresh: async () => { refreshes++; return { status: "read-only-open-model-catalog", entries: [] }; } };
  const server = createMiningPracticeApp({ root: new URL("..", import.meta.url).pathname, catalog });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/catalog`)).status, 200);
    assert.equal((await fetch(`${base}/catalog?repo=../../private`)).status, 404);
    assert.equal((await fetch(`${base}/catalog/refresh`, { method: "POST", body: "", headers: { Origin: "https://evil.test" } })).status, 403);
    assert.equal((await fetch(`${base}/catalog/refresh`, { method: "POST", body: "repo=evil", headers: { Origin: base } })).status, 403);
    assert.equal(refreshes, 0);
    assert.equal((await fetch(`${base}/catalog/refresh`, { method: "POST", body: "", headers: { Origin: base } })).status, 200);
    assert.equal(refreshes, 1);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("portrait UI retains selected exact revision across refresh and language switch", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const listeners = new Map();
  function node(id) {
    return { id, hidden: true, disabled: false, dataset: {}, textContent: "", value: "",
      setAttribute() {}, addEventListener(event, callback) { listeners.set(`${id}:${event}`, callback); } };
  }
  function select(id) {
    return { ...node(id), children: [], replaceChildren(...children) { this.children = children; this.value = children[0]?.value ?? ""; },
      append(child) { this.children.push(child); } };
  }
  const ids = ["start", "progress", "result", "error", "error-message", "connection", "language", "score", "technical", "catalog-state", "catalog-refresh"];
  const nodes = new Map(ids.map((id) => [`#${id}`, node(id)]));
  nodes.set("#catalog-model", select("catalog-model"));
  nodes.set("#catalog-version", select("catalog-version"));
  let version = shaA;
  let stale = false;
  const document = {
    documentElement: { lang: "ru" }, visibilityState: "visible", querySelector: (key) => nodes.get(key), querySelectorAll: () => [],
    createElement: () => ({ value: "", textContent: "" }),
  };
  runInNewContext(readFileSync(`${root}/mining-app/app.js`, "utf8"), {
    document, navigator: { language: "ru-RU" }, AbortController, TypeError,
    fetch: async (path) => ({ ok: true, json: async () => path === "/status"
      ? { status: "local-model-service-ready" }
      : { status: "read-only-open-model-catalog", rewardEligible: false, runnableRepo: null, stale,
        entries: [
          { provider: "Qwen", name: "Qwen3 0.6B", repo: qwen, runnable: false,
            versions: version === shaA ? [shaA] : version === shaB ? [shaA, shaB] : [shaB, shaC] },
          { provider: "TinyLlama", name: "TinyLlama 1.1B Chat", repo: tiny, runnable: false, versions: [shaA] },
        ] },
    }),
    setInterval: () => 0, setTimeout, clearTimeout,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const model = nodes.get("#catalog-model");
  const revision = nodes.get("#catalog-version");
  assert.equal(model.disabled, false);
  model.value = qwen;
  listeners.get("catalog-model:change")();
  assert.equal(revision.children[0].textContent, "Выберите ревизию");
  revision.value = shaA;
  listeners.get("catalog-version:change")();
  model.value = tiny;
  listeners.get("catalog-model:change")();
  assert.equal(revision.value, "", "switching model must not carry over the matching SHA");
  model.value = qwen;
  listeners.get("catalog-model:change")();
  revision.value = shaA;
  listeners.get("catalog-version:change")();
  version = shaB;
  await listeners.get("catalog-refresh:click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(revision.children.map((item) => item.value), ["", shaA, shaB]);
  assert.equal(revision.value, shaA, "new HEAD cannot silently switch the selected revision");
  stale = true;
  listeners.get("catalog-refresh:click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(nodes.get("#catalog-state").textContent, /могут устареть/);
  listeners.get("language:click")();
  assert.equal(revision.value, shaA);
  assert.equal(revision.children[0].textContent, "Choose a revision");
  assert.match(nodes.get("#catalog-state").textContent, /View only/);
  assert.match(nodes.get("#catalog-state").textContent, /may be outdated/);
  version = shaC;
  listeners.get("catalog-refresh:click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(revision.value, shaA, "an evicted observed SHA remains explicitly visible while selected");
  assert.match(nodes.get("#catalog-state").textContent, /no longer in the short list/);
});
