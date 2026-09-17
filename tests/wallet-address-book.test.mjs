import assert from "node:assert/strict";
import test from "node:test";
import { ADDRESS_BOOK_STORAGE_KEY, readAddressBook, saveAddressBookContact } from "../wallet-ui/address-book.js";
import { decodePaymentQrFrames, encodePaymentQrFrames, qrMatrix } from "../wallet-ui/qr.js";

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
