// The shared test network the apps join (docs/shared-testnet.md). Its genesis
// hash is pinned here: an app accepts the network only if the genesis it
// serves hashes to this value, and NIR Wallet then verifies every balance
// against that genesis.
import { NirChain } from "./chain.mjs";

export const SHARED_NETWORK = Object.freeze({
  url: process.env.NIR_SHARED_NETWORK_URL ?? "https://testnet.nircoin.com",
  networkId: "nir-shared-testnet-1",
  genesisHash: process.env.NIR_SHARED_NETWORK_GENESIS
    ?? "ce1662e5fce66365520d33cf2c770aec20d998fbccf1778f20c9bee7cad0ea16",
});

export function sharedNetworkAvailable(network = SHARED_NETWORK) {
  return typeof network.genesisHash === "string" && /^[0-9a-f]{64}$/.test(network.genesisHash);
}

// Throws unless `genesis` is the pinned shared network's genesis.
export function verifySharedGenesis(genesis, network = SHARED_NETWORK) {
  if (!sharedNetworkAvailable(network)) throw new Error("the shared network is not configured yet");
  const chain = new NirChain(genesis);
  if (chain.networkId !== network.networkId || chain.tipHash !== network.genesisHash) {
    throw new Error("the shared network does not match NIR's pinned genesis");
  }
  return chain;
}
