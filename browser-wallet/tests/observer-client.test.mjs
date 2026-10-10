import assert from "node:assert/strict";
import test from "node:test";
import {
  checkedObserverBalance, formatAtomicBalance, parseObserverSettings, refreshObserverAccount,
} from "../src/observer-client.js";

const address = `nir1${"a".repeat(64)}`;
const settings = {
  url: "http://127.0.0.1:8787", token: "b".repeat(64),
  networkId: "nir-local-test", genesisHash: "c".repeat(64),
};
const valid = {
  verified: true, address, networkId: settings.networkId,
  genesisHash: settings.genesisHash,
  statement: {
    networkId: settings.networkId, height: 4, tipHash: "d".repeat(64),
    account: { address, atomicBalance: "123456789" },
  },
};

test("observer URL cannot escape loopback or smuggle credentials/path", () => {
  assert.deepEqual(parseObserverSettings(settings), settings);
  for (const url of ["http://localhost:8787", "http://127.0.0.2:8787", "https://127.0.0.1:8787",
    "http://127.0.0.1:8787/path", "http://evil@127.0.0.1:8787", "http://127.0.0.1:8787/?x=1",
    "http://127.0.0.1:8787#frag", "http://127.0.0.1", "invalid"]) {
    assert.throws(() => parseObserverSettings({ ...settings, url }), { name: "Error" });
  }
  assert.throws(() => parseObserverSettings({ ...settings, token: "not-a-token" }));
  assert.throws(() => parseObserverSettings({ ...settings, genesisHash: "0".repeat(63) }));
});

test("read-only observer response is scoped to exact address, network and genesis", () => {
  assert.deepEqual(checkedObserverBalance(valid, settings, address), {
    atomicBalance: "123456789", height: 4,
  });
  assert.equal(formatAtomicBalance("123456789"), "1.23456789");
  assert.equal(formatAtomicBalance("0"), "0.00000000");
  for (const altered of [
    { verified: false }, { address: `nir1${"e".repeat(64)}` }, { networkId: "other" },
    { genesisHash: "f".repeat(64) }, { statement: { ...valid.statement, networkId: "other" } },
    { statement: { ...valid.statement, height: 0 } },
    { statement: { ...valid.statement, account: { address: `nir1${"e".repeat(64)}`, atomicBalance: "1" } } },
    { statement: { ...valid.statement, account: { address, atomicBalance: "-1" } } },
  ]) {
    assert.throws(() => checkedObserverBalance({ ...valid, ...altered }, settings, address));
  }
});

test("forged local process can reply verified:true: UI must never call this independent verification", async () => {
  const fakeLocalProcess = async (url, options) => {
    assert.equal(url, "http://127.0.0.1:8787/v1/refresh-account");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["x-nir-observer-token"], settings.token);
    return { ok: true, json: async () => valid };
  };
  // This is merely a scoped report from a process the extension has not authenticated.
  assert.deepEqual(await refreshObserverAccount(settings, address, fakeLocalProcess), {
    atomicBalance: "123456789", height: 4,
  });
});
