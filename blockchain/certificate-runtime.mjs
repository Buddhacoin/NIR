import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { certificatePinsAtHeight, topologyHistoryCommitment } from "./certificate-lifecycle.mjs";
import { loadCertificateHistory, verifyCertificateHistoryAnchor }
  from "./certificate-lifecycle-store.mjs";
import { readBoundedPublicJsonFile } from "./secure-public-json.mjs";
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


export function loadRuntimeCertificateHistory(directory, genesis, {
  externalAnchorPath = null,
} = {}) {
  const context = runtimeCertificateContext(directory, genesis);
  const externalAnchor = externalAnchorPath === null ? null : readBoundedPublicJsonFile(
    externalAnchorPath, { label: "external certificate history anchor", maximumBytes: 1024 });
  const loaded = loadCertificateHistory(join(directory, "certificates"), context,
    { externalAnchor });
  if (loaded.history.some((record) =>
    !Object.hasOwn(context.validatorSetsByTopologyHash, record.topologyHistoryHash))) {
    throw new Error("certificate lifecycle record has no verified validator topology");
  }
  return { ...loaded, context, externalAnchor };
}

export class RuntimeCertificatePins {
  #directory;
  #genesis;
  #mode;
  #externalAnchorPath;
  #anchorFloor = null;

  constructor(directory, genesis, {
    mode = CERTIFICATE_MODE_DEV_GENESIS, externalAnchorPath = null,
  } = {}) {
    if (mode !== CERTIFICATE_MODE_DEV_GENESIS && mode !== CERTIFICATE_MODE_LIFECYCLE) {
      throw new Error("certificate transport mode is invalid");
    }
    if (mode === CERTIFICATE_MODE_LIFECYCLE &&
        (typeof externalAnchorPath !== "string" || !isAbsolute(externalAnchorPath))) {
      throw new Error("certificate lifecycle requires an external history anchor path");
    }
    this.#directory = resolve(directory);
    if (mode === CERTIFICATE_MODE_LIFECYCLE) {
      const relativePath = relative(realpathSync(this.#directory), realpathSync(externalAnchorPath));
      if (relativePath === "" || (!isAbsolute(relativePath) && relativePath !== ".." &&
          !relativePath.startsWith(`..${sep}`))) {
        throw new Error("external certificate history anchor must be outside node state");
      }
    }
    this.#genesis = structuredClone(genesis);
    this.#mode = mode;
    this.#externalAnchorPath = externalAnchorPath;
    if (mode === CERTIFICATE_MODE_LIFECYCLE) {
      this.loadVerifiedHistory();
    }
  }

  get mode() { return this.#mode; }

  loadVerifiedHistory() {
    if (this.#mode !== CERTIFICATE_MODE_LIFECYCLE) {
      throw new Error("certificate history requires lifecycle mode");
    }
    const loaded = loadRuntimeCertificateHistory(this.#directory, this.#genesis,
      { externalAnchorPath: this.#externalAnchorPath });
    if (this.#anchorFloor !== null) {
      if (loaded.externalAnchor === null ||
          loaded.externalAnchor.recordCount < this.#anchorFloor.recordCount) {
        throw new Error("external certificate history anchor rolled back");
      }
      verifyCertificateHistoryAnchor(loaded.history, loaded.context, this.#anchorFloor);
    }
    if (loaded.externalAnchor !== null) {
      this.#anchorFloor = structuredClone(loaded.externalAnchor);
    }
    return loaded;
  }

  pinsFor(validatorAddress, height, genesisPin = null) {
    if (this.#mode === CERTIFICATE_MODE_DEV_GENESIS) {
      return genesisPin === null ? null : [genesisPin];
    }
    const loaded = this.loadVerifiedHistory();
    const pins = certificatePinsAtHeight(loaded.history, validatorAddress, height);
    if (pins.length === 0) {
      throw new Error("validator has no active lifecycle TLS certificate");
    }
    return pins;
  }
}
