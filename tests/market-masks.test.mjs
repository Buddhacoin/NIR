import assert from "node:assert/strict";
import test from "node:test";
import { createMasks, MASKED, short } from "../blockchain/market-masks.mjs";

test("known wallets go out under ids and half their address", () => {
  const masks = createMasks({ featured: { "vitalik-buterin": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" } });
  const vitalik = masks.mask({ address: "0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045", name: null });
  assert.equal(vitalik.address, "w:vitalik-buterin");
  assert.equal(vitalik.short, short("0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045"));
  assert.equal(masks.addressOf("w:vitalik-buterin"), "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
  // A named wallet gets a stable hashed id that leads back to it.
  const named = masks.mask({ address: "0x28C6c06298d514Db089934071355E5743bf21d60", name: "Binance 14" });
  assert.match(named.address, MASKED);
  assert.equal(masks.mask({ address: "0x28c6c06298d514db089934071355e5743bf21d60", name: "x" }).address, named.address);
  assert.equal(masks.addressOf(named.address), "0x28c6c06298d514db089934071355e5743bf21d60");
  // A wallet without a name, an organisation and an id already given stay as they are.
  const plain = { address: "0x1111111111111111111111111111111111111111", name: null };
  assert.equal(masks.mask(plain), plain);
  assert.equal(masks.mask({ address: "entity:Binance", name: "Binance" }).address, "entity:Binance");
  assert.equal(masks.mask({ address: "w:okx", name: "OKX" }).address, "w:okx");
  assert.equal(masks.addressOf("w:nothing-here"), null);
  assert.deepEqual(masks.featuredIds(), ["w:vitalik-buterin"]);
  masks.close();
});
