// NIR Wallet on a Mac checks balances against the network NIR Майнер runs
// on the same Mac (docs/proof-mining.md). The wallet does not take the node's
// word for a balance: it verifies the validators' finality signatures and an
// account proof. What it trusts is the network's own genesis, read from the
// miner's data folder of this same user: the genesis validators and the
// release keys that sign protocol upgrades. A different or recreated network
// has a different genesis and gets its own checkpoint file.
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { NirChain } from "./chain.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";
import { SHARED_NETWORK, verifySharedGenesis } from "./shared-network.mjs";

export function defaultMiningDirectory() {
  return join(homedir(), "Library", "Application Support", "NIR Model Lab", "mining");
}

export function defaultMinerNetworkDirectory() {
  return join(defaultMiningDirectory(), "devnet");
}

// The network NIR Майнер uses: the shared test network, whose genesis must
// match the hash pinned in this app, or its practice network on this Mac.
export function activeMinerNetworkTrust({ miningDirectory = defaultMiningDirectory(), storageRoot,
  sharedNetwork = SHARED_NETWORK }) {
  let mode = "local";
  try { mode = JSON.parse(readFileSync(join(miningDirectory, "active-network.json"), "utf8")).mode; } catch {}
  if (mode !== "shared") return minerNetworkTrust({ networkDirectory: join(miningDirectory, "devnet"), storageRoot });
  try {
    verifySharedGenesis(parseConsensusJson(readFileSync(join(miningDirectory, "shared", "genesis.json"), "utf8")),
      sharedNetwork);
  } catch {
    return null;
  }
  return minerNetworkTrust({ networkDirectory: join(miningDirectory, "shared"), storageRoot });
}

// Returns the bridge's trust options, or null while the miner has made no
// network yet.
export function minerNetworkTrust({ networkDirectory = defaultMinerNetworkDirectory(), storageRoot }) {
  const path = join(networkDirectory, "genesis.json");
  let genesis;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || stat.uid !== process.getuid?.()) return null;
    genesis = parseConsensusJson(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const chain = new NirChain(genesis);
  const block = chain.blockAtHeight(0);
  return {
    trustAnchor: {
      expectedNetworkId: chain.networkId,
      genesisCheckpoint: { accountStateRoot: block.accountStateRoot, height: 0, stateRoot: block.stateRoot,
        // The devnet's genesis starts above the base protocol version.
        protocolVersion: block.protocolVersion, tipHash: block.hash, validatorSetId: chain.validatorSetId },
      handoffs: [],
      ...(genesis.protocolUpgradeReleaseAnchor
        ? { protocolUpgradeReleaseAnchor: genesis.protocolUpgradeReleaseAnchor } : {}),
      trustedValidators: genesis.validators,
    },
    trustCheckpointPath: join(storageRoot, `miner-network-${block.hash.slice(0, 16)}.trust.json`),
  };
}
