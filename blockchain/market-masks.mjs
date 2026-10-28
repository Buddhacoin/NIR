// Known wallets' addresses stay on the server, as the analytics sites keep their book of attributions:
// a wallet with a name (an exchange's, a fund's, a person's) goes out under an id, "w:<id>", and its
// pages live at /w/<id>; only half of its address is shown (`short`). The hand-picked wallets
// (data/featured-wallets.json) have readable ids ("w:vitalik-buterin"); every other one gets a stable
// id from a keyed hash, kept in masks.db so a shared link keeps working. A visitor who types a full
// address already knows it: that page works as before.
import { createHmac, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const MASKED = /^w:[a-z0-9-]{2,40}$/;
export const short = (address) => (address ? `${address.slice(0, Math.ceil(address.length / 2))}…` : null);

export function createMasks({ file = ":memory:", featured = {} } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS masks (id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS mask_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  let secret = db.prepare("SELECT value FROM mask_meta WHERE key = 'secret'").get()?.value;
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO mask_meta (key, value) VALUES ('secret', ?)").run(secret);
  }
  // EVM addresses are one wallet whatever their letters' case; the others are kept as written.
  const canonical = (address) => (/^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : address);
  const bySlug = new Map(Object.entries(featured).filter(([slug, address]) => /^[a-z0-9-]{2,40}$/.test(slug) && address).map(([slug, address]) => [slug, address]));
  const slugOf = new Map([...bySlug].map(([slug, address]) => [canonical(address), slug]));
  const findId = db.prepare("SELECT id FROM masks WHERE address = ?");
  const findAddress = db.prepare("SELECT address FROM masks WHERE id = ?");
  const insert = db.prepare("INSERT OR IGNORE INTO masks (id, address) VALUES (?, ?)");
  const memo = new Map(); // canonical address → id, the ones seen since the start

  function idOf(address) {
    const key = canonical(String(address ?? ""));
    if (!key) return null;
    if (slugOf.has(key)) return slugOf.get(key);
    if (memo.has(key)) return memo.get(key);
    let id = findId.get(key)?.id;
    if (!id) {
      // Twelve letters and digits from a keyed hash: unguessable from the address, the same every time.
      id = createHmac("sha256", secret).update(key).digest("base64url").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 12);
      insert.run(id, key);
      id = findId.get(key)?.id ?? id;
    }
    if (memo.size > 200_000) memo.delete(memo.keys().next().value);
    memo.set(key, id);
    return id;
  }
  // The address behind an id ("w:…" or the bare id), or null.
  function addressOf(value) {
    const id = String(value ?? "").replace(/^w:/, "");
    if (!/^[a-z0-9-]{2,40}$/.test(id)) return null;
    return bySlug.get(id) ?? findAddress.get(id)?.address ?? null;
  }
  const isFeatured = (address) => slugOf.has(canonical(String(address ?? "")));
  // A party with a name (or a hand-picked one) goes out under its id, with half its address.
  function mask(party) {
    if (!party?.address || MASKED.test(party.address) || /^entity:/.test(party.address)) return party;
    if (!party.name && !isFeatured(party.address)) return party;
    return { ...party, address: `w:${idOf(party.address)}`, short: short(party.address) };
  }
  // The hand-picked wallets as the pages know them: ids, never addresses.
  const featuredIds = () => [...bySlug.keys()].map((slug) => `w:${slug}`);
  return { idOf, addressOf, mask, isFeatured, featuredIds, close: () => db.close() };
}
