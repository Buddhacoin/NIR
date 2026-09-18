export const ADDRESS_PATTERN = /^nir1[0-9a-f]{64}$/;
const NETWORK_PATTERN = /^[a-zA-Z0-9._:-]{3,128}$/;
const CONTACT_LABEL_MAX = 64;
export const ADDRESS_BOOK_STORAGE_KEY = "nir-address-book-v1";

function fail(message) { throw new Error(message); }

function cleanLabel(value) {
  if (typeof value !== "string") fail("Название контакта должно быть текстом.");
  const label = value.trim().replace(/\s+/g, " ");
  if (!label || label.length > CONTACT_LABEL_MAX ||
      /[\u0000-\u001f\u007f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(label)) {
    fail("Название контакта должно содержать от 1 до 64 печатных символов.");
  }
  return label;
}

export function normalizeContact(value, now = Date.now()) {
  if (!value || typeof value !== "object") fail("Контакт имеет неверный формат.");
  const address = typeof value.address === "string" ? value.address.trim().toLowerCase() : "";
  const networkId = typeof value.networkId === "string" ? value.networkId.trim() : "";
  if (!ADDRESS_PATTERN.test(address)) fail("Адрес контакта NIR неверен.");
  if (!NETWORK_PATTERN.test(networkId)) fail("Сеть контакта неверна.");
  const id = typeof value.id === "string" && /^[0-9a-f]{32}$/i.test(value.id)
    ? value.id.toLowerCase() : null;
  const timestamp = Number.isSafeInteger(value.updatedAt) ? value.updatedAt : now;
  return {
    ...(id ? { id } : {}),
    address,
    label: cleanLabel(value.label),
    networkId,
    ...(Number.isSafeInteger(value.createdAt) ? { createdAt: value.createdAt } : {}),
    updatedAt: timestamp,
  };
}

export function readAddressBook(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(ADDRESS_BOOK_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.contacts) || parsed.contacts.length > 500) return [];
    const ids = new Set();
    const contacts = [];
    for (const candidate of parsed.contacts) {
      const contact = normalizeContact(candidate);
      if (!contact.id || ids.has(contact.id)) continue;
      ids.add(contact.id);
      contacts.push(contact);
    }
    return contacts.sort((a, b) => a.label.localeCompare(b.label, "ru"));
  } catch { return []; }
}

export function addressChangeFor(contacts, candidate) {
  const exact = contacts.find((contact) => contact.id === candidate.id);
  const matchingLabel = contacts.find((contact) =>
    contact.id !== candidate.id && contact.label.localeCompare(candidate.label, "ru", { sensitivity: "accent" }) === 0,
  );
  const existing = exact ?? matchingLabel;
  if (!existing) return null;
  if (existing.address !== candidate.address || existing.networkId !== candidate.networkId) return existing;
  return null;
}

export function saveAddressBookContact({ storage = globalThis.localStorage, contacts, candidate, confirmAddressChange = false, now = Date.now() }) {
  const normalized = normalizeContact(candidate, now);
  const safeContacts = Array.isArray(contacts) ? contacts.map((contact) => normalizeContact(contact, now)) : [];
  if (safeContacts.length > 500) fail("Адресная книга превышает локальный лимит.");
  const change = addressChangeFor(safeContacts, normalized);
  if (change && !confirmAddressChange) {
    const error = new Error("Адрес известного контакта изменился и требует явного подтверждения.");
    error.code = "ADDRESS_CHANGE_CONFIRMATION_REQUIRED";
    error.existing = change;
    throw error;
  }
  const existing = safeContacts.find((contact) => contact.id === normalized.id) ?? change;
  const contact = {
    ...normalized,
    id: existing?.id ?? crypto.randomUUID().replace(/-/g, ""),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const next = safeContacts.filter((item) => item.id !== contact.id);
  next.push(contact);
  if (next.length > 500) fail("Адресная книга превышает локальный лимит.");
  next.sort((a, b) => a.label.localeCompare(b.label, "ru"));
  storage.setItem(ADDRESS_BOOK_STORAGE_KEY, JSON.stringify({ version: 1, contacts: next }));
  return { contact, contacts: next };
}

export function removeAddressBookContact({ storage = globalThis.localStorage, contacts, id }) {
  const next = contacts.filter((contact) => contact.id !== id);
  storage.setItem(ADDRESS_BOOK_STORAGE_KEY, JSON.stringify({ version: 1, contacts: next }));
  return next;
}
