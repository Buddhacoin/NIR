import { join, resolve } from "node:path";

import { certificatePinsAtHeight, topologyHistoryCommitment } from "./certificate-lifecycle.mjs";
import { loadCertificateHistory } from "./certificate-lifecycle-store.mjs";
import { loadValidatorHandoffs } from "./validator-handoff-store.mjs";
import {
  loadValidatorTopologyHistory,
  verifyValidatorTopologyHistory,
} from "./validator-topology-history.mjs";

export const CERTIFICATE_MODE_DEV_GENESIS = "dev-genesis";
export const CERTIFICATE_MODE_LIFECYCLE = "lifecycle";

export function runtimeCertificateContext(directory, genesis) {
  const handoffContext = {
    expectedNetworkId: genesis.networkId,
    trustedValidators: genesis.validators,
  };
  const handoffs = loadValidatorHandoffs(join(directory, "handoffs"), handoffContext).handoffs;
  const topologyContext = {
    genesisPeerRegistry: genesis.peerRegistry,
    genesisValidators: genesis.validators,
    handoffs,
    networkId: genesis.networkId,
  };
  const topology = loadValidatorTopologyHistory(join(directory, "topologies"), topologyContext);
  if (topology.onboardings.length !== handoffs.length) {
    throw new Error("certificate lifecycle requires complete validator topology history");
  }
  const validatorSetsByTopologyHash = {};
  for (let length = 0; length <= handoffs.length; length += 1) {
    const prefixHandoffs = handoffs.slice(0, length);
    const prefixOnboardings = topology.onboardings.slice(0, length);
    const verified = verifyValidatorTopologyHistory({
      ...topologyContext,
      handoffs: prefixHandoffs,
      onboardings: prefixOnboardings,
    });
    const commitment = topologyHistoryCommitment({
      handoffs: prefixHandoffs,
      onboardings: prefixOnboardings,
    });
    validatorSetsByTopologyHash[commitment] = verified.trustedValidators;
  }
  return {
    networkId: genesis.networkId,
    validatorSetsByTopologyHash,
    validators: topology.trustedValidators,
  };
}


export function loadRuntimeCertificateHistory(directory, genesis) {
  const context = runtimeCertificateContext(directory, genesis);
  const loaded = loadCertificateHistory(join(directory, "certificates"), context);
  if (loaded.history.some((record) =>
    !Object.hasOwn(context.validatorSetsByTopologyHash, record.topologyHistoryHash))) {
    throw new Error("certificate lifecycle record has no verified validator topology");
  }
  return { ...loaded, context };
}

export class RuntimeCertificatePins {
  #directory;
  #genesis;
  #mode;

  constructor(directory, genesis, { mode = CERTIFICATE_MODE_DEV_GENESIS } = {}) {
    if (mode !== CERTIFICATE_MODE_DEV_GENESIS && mode !== CERTIFICATE_MODE_LIFECYCLE) {
      throw new Error("certificate transport mode is invalid");
    }
    this.#directory = resolve(directory);
    this.#genesis = structuredClone(genesis);
    this.#mode = mode;
  }

  get mode() { return this.#mode; }

  pinsFor(validatorAddress, height, genesisPin = null) {
    if (this.#mode === CERTIFICATE_MODE_DEV_GENESIS) {
      return genesisPin === null ? null : [genesisPin];
    }
    const loaded = loadRuntimeCertificateHistory(this.#directory, this.#genesis);
    const pins = certificatePinsAtHeight(loaded.history, validatorAddress, height);
    if (pins.length === 0) {
      throw new Error("validator has no active lifecycle TLS certificate");
    }
    return pins;
  }
}
