// A deliberately isolated teaching ledger. It is NOT NIR consensus state and
// cannot issue a spendable coin or change a wallet vault.
export const SYNTHETIC_NETWORK_ID = "nir-synthetic-local-1";
const TRAINING_UNITS = 7n;

export function createSyntheticTransferSession() {
  let started = false;
  let remaining = 0n;
  const balances = new Map();
  const seen = new Set();
  const history = [];

  function snapshot() {
    return {
      status: "synthetic-training-only", networkId: SYNTHETIC_NETWORK_ID,
      simulationOnly: true, networkSubmitted: false, walletChanged: false,
      transferableNir: "0", started, remaining: remaining.toString(),
      balances: Object.fromEntries([...balances].map(([key, value]) => [key, value.toString()])),
      history: history.map((entry) => ({ ...entry })),
    };
  }

  function startTraining() {
    if (started) throw new Error("training already started");
    started = true;
    remaining = TRAINING_UNITS;
    return snapshot();
  }

  function transfer({ recipient, amount, id, networkId = SYNTHETIC_NETWORK_ID } = {}) {
    if (!started) throw new Error("training has not started");
    if (networkId !== SYNTHETIC_NETWORK_ID) throw new Error("wrong synthetic network");
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error("invalid transfer id");
    if (seen.has(id)) throw new Error("transfer replay");
    if (typeof recipient !== "string" || !/^nir1[0-9a-f]{64}$/.test(recipient))
      throw new Error("invalid recipient");
    if (typeof amount !== "string" || !/^[1-9][0-9]{0,5}$/.test(amount)) throw new Error("invalid amount");
    const units = BigInt(amount);
    if (units > remaining) throw new Error("insufficient synthetic balance");
    // Commit all state together only after every validation succeeds.
    remaining -= units;
    balances.set(recipient, (balances.get(recipient) ?? 0n) + units);
    seen.add(id);
    const entry = { id, recipient, amount, networkId: SYNTHETIC_NETWORK_ID,
      status: "synthetic-transfer", simulationOnly: true, walletChanged: false,
      networkSubmitted: false, recipientOwnershipVerified: false };
    history.push(entry);
    return { ...entry };
  }

  return { snapshot, startTraining, transfer };
}
