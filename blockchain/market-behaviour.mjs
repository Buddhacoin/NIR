// Names from wallets' behaviour, the way the analytics sites grow their books beyond the public labels:
// an exchange gives every customer a deposit address, and each one passes all it receives on to the
// exchange's hot wallet. So, from NIR Markets' own store of transfers (market-ledger.mjs):
// - a wallet that sent everything (two transfers or more) to one wallet the book knows as an exchange's
//   is that exchange's deposit address: "Binance: Deposit";
// - a wallet nobody has named that dozens of such single-target senders feed, and that pays out about as
//   often itself, is most likely an exchange's hot wallet: it gets the category, without a name. (A wallet
//   that only takes in, such as the first block's address many send keepsakes to, is not; an earlier such
//   guess is taken back.)
// Guesses go into the book as the "behaviour" source (market-names.mjs infer): they never replace a
// name from any other source, and the history of attributions keeps where each came from.
const DAY = 86_400_000;

// The owner of a named wallet: its label's entity, else the name before ":" or "(" ("Binance: Hot Wallet 14").
export const ownerOf = (value) => value?.entity ?? (String(value?.name ?? "").split(/[:(]/)[0].replace(/\s+\d+$/, "").trim() || null);

export function guessFromBehaviour(candidates, nameOf, { feeders = 25, sends = () => feeders } = {}) {
  const guesses = [];
  Object.defineProperty(guesses, "rejected", { value: [] }); // fed like a hot wallet but never paying out
  Object.defineProperty(guesses, "earlier", { value: [] }); // hot wallets guessed before, checked again
  const fed = new Map(); // receiver → how many single-target senders feed it
  for (const { sender, receiver } of candidates) {
    fed.set(receiver, (fed.get(receiver) ?? 0) + 1);
    const target = nameOf(receiver);
    if (target?.category !== "exchange" || target.guessed || nameOf(sender)?.name) continue;
    const owner = ownerOf(target);
    if (owner) guesses.push({ address: sender, name: `${owner}: Deposit`, entity: owner, category: "exchange" });
  }
  for (const [receiver, count] of fed) {
    if (count < feeders) continue;
    if (sends(receiver) < feeders) { guesses.rejected.push(receiver); continue; }
    const known = nameOf(receiver);
    if (!known) guesses.push({ address: receiver, name: null, category: "exchange" });
    else if (known.guessed && !known.name) guesses.earlier.push(receiver);
  }
  return guesses;
}

// `hasCode(address)`: whether it is a contract (market-chain.mjs); a contract fed like a hot wallet (a pool, a
// proxy) is no exchange's wallet, and an earlier such guess is taken back.
export function createBehaviour({ ledger, names, hasCode = async () => false, now = Date.now, every = 3_600_000, window = 90 * DAY } = {}) {
  let last = null;
  async function run() {
    if (!ledger || !names) return null;
    const candidates = ledger.singleReceivers(now() - window);
    const guesses = guessFromBehaviour(candidates, (address) => names.name(address), { sends: (address) => ledger.sent?.(address, now() - window) ?? 25 });
    const kept = [];
    for (const guess of guesses) {
      if (guess.name === null && await hasCode(guess.address).catch(() => false)) guesses.rejected.push(guess.address);
      else kept.push(guess);
    }
    for (const address of guesses.earlier) if (await hasCode(address).catch(() => false)) guesses.rejected.push(address);
    last = { at: now(), candidates: candidates.length, added: names.infer(kept), retracted: names.retract?.(guesses.rejected) ?? 0 };
    return last;
  }
  function start() {
    const first = setTimeout(() => { run().catch(() => {}); }, 120_000);
    const timer = setInterval(() => { run().catch(() => {}); }, every);
    first.unref?.();
    timer.unref?.();
    return () => { clearTimeout(first); clearInterval(timer); };
  }
  return { run, start, status: () => last };
}
