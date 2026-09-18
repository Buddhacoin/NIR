import assert from "node:assert/strict";
import test from "node:test";
import { ADDRESS_BOOK_STORAGE_KEY, normalizeContact, readAddressBook, saveAddressBookContact } from "../wallet-ui/address-book.js";
import { decodePaymentQrFrames, encodePaymentQrFrames, qrMatrix } from "../wallet-ui/qr.js";
import { generateWallet } from "../blockchain/crypto.mjs";
import { createPaymentRequest, verifyPaymentRequest } from "../blockchain/payment-request.mjs";

const ADDRESS_A = `nir1${"a".repeat(64)}`;
const ADDRESS_B = `nir1${"b".repeat(64)}`;
const NETWORK = "nir-local-testnet";
function memoryStorage() { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values }; }

test("address book stores only validated public contact metadata", () => {
  const storage = memoryStorage();
  const saved = saveAddressBookContact({ storage, contacts: [], candidate: { label: "Магазин", address: ADDRESS_A, networkId: NETWORK }, now: 1 });
  assert.equal(saved.contacts[0].address, ADDRESS_A);
  assert.equal(saved.contacts[0].networkId, NETWORK);
  assert.deepEqual(readAddressBook(storage), saved.contacts);
  assert.match(storage.values.get(ADDRESS_BOOK_STORAGE_KEY), /"label":"Магазин"/);
  assert.doesNotMatch(storage.values.get(ADDRESS_BOOK_STORAGE_KEY), /password|private|seed|token/i);
});

test("address change for an existing label needs a separate confirmation", () => {
  const storage = memoryStorage();
  const first = saveAddressBookContact({ storage, contacts: [], candidate: { label: "Касса", address: ADDRESS_A, networkId: NETWORK }, now: 1 });
  assert.throws(() => saveAddressBookContact({ storage, contacts: first.contacts, candidate: { label: "Касса", address: ADDRESS_B, networkId: NETWORK }, now: 2 }), { code: "ADDRESS_CHANGE_CONFIRMATION_REQUIRED" });
  const changed = saveAddressBookContact({ storage, contacts: first.contacts, candidate: { label: "Касса", address: ADDRESS_B, networkId: NETWORK }, confirmAddressChange: true, now: 2 });
  assert.equal(changed.contacts.length, 1);
  assert.equal(changed.contacts[0].address, ADDRESS_B);
});

test("malformed local storage is ignored without exposing it as a contact", () => {
  const storage = memoryStorage();
  storage.setItem(ADDRESS_BOOK_STORAGE_KEY, JSON.stringify({ version: 1, contacts: [{ label: "x", address: "not-an-address", networkId: NETWORK }] }));
  assert.deepEqual(readAddressBook(storage), []);
});

test("address book rejects excessive hostile-browser state", () => {
  const contacts = Array.from({ length: 500 }, (_, index) => ({
    address: `nir1${index.toString(16).padStart(64, "0")}`,
    createdAt: 1,
    id: index.toString(16).padStart(32, "0"),
    label: `Contact ${index}`,
    networkId: NETWORK,
    updatedAt: 1,
  }));
  assert.throws(() => saveAddressBookContact({
    contacts, storage: memoryStorage(), now: 2,
    candidate: { address: ADDRESS_A, label: "Overflow", networkId: NETWORK },
  }), /локальный лимит/u);
});

test("payment QR frames round-trip locally and reject missing fragments", () => {
  const json = JSON.stringify({ amount: "100000000", memo: "тест", recipient: ADDRESS_A, networkId: NETWORK });
  const frames = encodePaymentQrFrames(json);
  assert.ok(frames.length > 1);
  assert.equal(decodePaymentQrFrames(frames.join("\n")), json);
  assert.throws(() => decodePaymentQrFrames(frames.slice(1).join("\n")), /все QR-фрагменты/u);
  const matrix = qrMatrix(frames[0]);
  assert.equal(matrix.length, 37);
  assert.ok(matrix.every((row) => row.length === 37 && row.every((cell) => typeof cell === "boolean")));
});

test("hostile contact labels remain public inert text and display controls fail closed", () => {
  const storage = memoryStorage();
  const hostileLabels = [
    `<img src=x onerror="globalThis.pwned=true">`,
    `</b><script>globalThis.pwned=true</script>`,
    `&lt;svg onload=globalThis.pwned=true&gt;`,
    `Касса ${"💳".repeat(10)}`,
  ];
  let contacts = [];
  for (let index = 0; index < hostileLabels.length; index += 1) {
    ({ contacts } = saveAddressBookContact({
      storage, contacts, now: index + 1,
      candidate: { label: hostileLabels[index], address: index % 2 ? ADDRESS_A : ADDRESS_B,
        networkId: `${NETWORK}-${index}` },
    }));
  }
  const serialized = storage.values.get(ADDRESS_BOOK_STORAGE_KEY);
  assert.equal(readAddressBook(storage).length, hostileLabels.length);
  assert.doesNotMatch(serialized, /privateKey|password|seedPhrase|sessionToken/);
  for (const control of ["\u202e", "\u2066", "\u061c", "\u0000"]) {
    assert.throws(() => normalizeContact({
      label: `safe${control}spoof`, address: ADDRESS_A, networkId: NETWORK,
    }), /печатных символов/u);
  }
  assert.equal(normalizeContact({
    label: "safe\u2028label", address: ADDRESS_A, networkId: NETWORK,
  }).label, "safe label");
});

test("clipboard or QR mutation cannot change a signed payment request", () => {
  const wallet = generateWallet();
  const now = 2_000_000_000_000;
  const signed = createPaymentRequest({
    wallet, networkId: NETWORK, amount: "100000000", memo: "Заказ 42",
    expiresAt: now + 60_000, requestId: "c".repeat(64),
  });
  const encoded = encodePaymentQrFrames(JSON.stringify(signed)).join("\n");
  const decoded = JSON.parse(decodePaymentQrFrames(encoded));
  assert.deepEqual(verifyPaymentRequest(decoded, { networkId: NETWORK, now }), signed);
  for (const mutation of [
    { amount: "100000001" },
    { memo: `<img src=x onerror=alert(1)>` },
    { recipient: ADDRESS_B },
  ]) {
    const changed = JSON.parse(decodePaymentQrFrames(
      encodePaymentQrFrames(JSON.stringify({ ...signed, ...mutation })).join("\n"),
    ));
    assert.throws(() => verifyPaymentRequest(changed, { networkId: NETWORK, now }),
      /invalid|does not match/);
  }
});
