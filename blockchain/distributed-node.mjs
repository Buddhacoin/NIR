import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  blockHash,
  commitVoteForBlock,
  createTransfer,
  formatNir,
  NirChain,
  quoteTransferFee,
  transactionId,
  prepareCertificateHash,
  timeoutForRound,
  voteForBlock,
} from "./chain.mjs";
import {
  initializeBlockStore,
  installBlockStoreSnapshot,
  loadBlockStore,
  persistBlock,
} from "./block-store.mjs";
import {
  ATOMIC_UNITS,
  MAX_CONSENSUS_ROUND,
  MAX_TRANSACTIONS_PER_BLOCK,
  MIN_TRANSFER_FEE,
  SAFETY_POLICY_V1_COMMITMENT,
} from "./constants.mjs";
import { canonicalJson, generateWallet, publicWallet, verifyObject } from "./crypto.mjs";
import {
  createPeerRequest,
  createPeerResponse,
  verifyPeerRequest,
  verifyPeerResponse,
} from "./peer-auth.mjs";
import {
  createPeerRegistry,
  EMPTY_PEER_REGISTRY_HASH,
  peerRegistryHash,
} from "./peer-registry.mjs";
import { requestJson } from "./http-client.mjs";
import { createPeerAnnouncement } from "./peer-discovery.mjs";
import { installStateSnapshot } from "./snapshot-store.mjs";
import {
  createValidatorHandoffCandidate,
  mergeValidatorHandoffCandidates,
} from "./validator-handoff.mjs";
import {
  installValidatorHandoff,
  loadValidatorHandoffs,
} from "./validator-handoff-store.mjs";
import {
  MAX_SNAPSHOT_BYTES,
  createStateSnapshot,
  mergeStateSnapshotCandidates,
  verifyStateSnapshot,
  verifyStateSnapshotCandidate,
} from "./state-snapshot.mjs";
import {
  authorizeTransportAction,
  buildValidatorTransportView,
} from "./validator-transport-view.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const MAX_MEMPOOL_TRANSACTIONS = 1_000;

function writeExclusive(path, value, mode = 0o600) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8", flag: "wx", mode,
  });
  chmodSync(path, mode);
}

function writeAtomic(path, value, mode = 0o600) {
  const temporary = `${path}.next`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8", flag: "w", mode,
  });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
  }));
}

function referenceCapability() {
  return {
    artifactHash: `sha256:${"1".repeat(64)}`,
    behaviorCommitment: "2".repeat(64),
    capabilitiesBps: { "reasoning-v1": 1 },
  };
}

function loadChain(directory) {
  const genesis = readJson(join(directory, "genesis.json"));
  const history = loadValidatorHandoffs(join(directory, "handoffs"), {
    expectedNetworkId: genesis.networkId,
    trustedValidators: genesis.validators,
  });
  return {
    ...loadBlockStore(directory, genesis, {
      handoffs: history.handoffs,
      trustedValidators: genesis.validators,
    }),
    genesis,
    handoffs: history.handoffs,
  };
}

export function initializeDistributedDevnet(
  directory,
  {
    networkId = "nir-distributed-devnet",
    firstValidatorPort = 8791,
    tlsCertificateSha256 = null,
  } = {},
) {
  if (tlsCertificateSha256 !== null && !/^[0-9a-f]{64}$/.test(tlsCertificateSha256)) {
    throw new Error("development TLS certificate pin is invalid");
  }
  const root = resolve(directory);
  const coordinatorDirectory = join(root, "coordinator");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(coordinatorDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(join(coordinatorDirectory, "blocks"), { mode: 0o700 });
  const validators = Array.from({ length: 4 }, generateWallet);
  const validatorTransports = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const coordinator = generateWallet();
  const validatorUrls = validators.map((_, index) =>
    `${tlsCertificateSha256 === null ? "http" : "https"}://127.0.0.1:${firstValidatorPort + index}`);
  const peerRegistry = createPeerRegistry({
    activationHeight: 0,
    epoch: 0,
    networkId,
    peers: validators.map((validator, index) => ({
      tlsCertificateSha256,
      transport: publicWallet(validatorTransports[index]),
      url: validatorUrls[index],
      validatorAddress: validator.address,
    })),
    previousRegistryHash: EMPTY_PEER_REGISTRY_HASH,
  }, validators);
  const genesis = {
    beaconAuthorities: members(beacons, "beacon"),
    capabilityReferences: [referenceCapability()],
    evaluators: members(evaluators, "evaluator"),
    genesisTimestamp: 0,
    networkId,
    peerRegistry,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: members(validators, "validator"),
  };
  writeExclusive(join(coordinatorDirectory, "genesis.json"), genesis, 0o644);
  writeExclusive(join(coordinatorDirectory, "TREASURY-DEV-KEY.json"), treasury);
  writeExclusive(join(coordinatorDirectory, "COORDINATOR-KEY.json"), coordinator);
  initializeBlockStore(coordinatorDirectory, new NirChain(genesis));

  const validatorDirectories = validators.map((wallet, index) => {
    const validatorDirectory = join(root, "validators", `validator-${index}`);
    mkdirSync(join(validatorDirectory, "blocks"), { recursive: true, mode: 0o700 });
    mkdirSync(join(validatorDirectory, "commits"), { mode: 0o700 });
    mkdirSync(join(validatorDirectory, "prepares"), { mode: 0o700 });
    mkdirSync(join(validatorDirectory, "timeouts"), { mode: 0o700 });
    mkdirSync(join(validatorDirectory, "mempool"), { mode: 0o700 });
    writeExclusive(join(validatorDirectory, "genesis.json"), genesis, 0o644);
    writeExclusive(join(validatorDirectory, "VALIDATOR-KEY.json"), wallet);
    writeExclusive(join(validatorDirectory, "AUTHORIZED-COORDINATOR.json"), publicWallet(coordinator), 0o644);
    initializeBlockStore(validatorDirectory, new NirChain(genesis));
    return validatorDirectory;
  });
  for (let index = 0; index < validatorDirectories.length; index += 1) {
    const validatorDirectory = validatorDirectories[index];
    writeExclusive(join(validatorDirectory, "PEERS.json"), validatorUrls, 0o644);
    writeExclusive(join(validatorDirectory, "PEER-REGISTRY.json"), peerRegistry, 0o644);
    writeExclusive(join(validatorDirectory, "PEER-REGISTRIES.json"), [peerRegistry], 0o644);
    writeExclusive(join(validatorDirectory, "TRANSPORT-KEY.json"), validatorTransports[index]);
  }
  writeExclusive(join(root, "network.json"), {
    coordinatorDirectory,
    networkId,
    peerRegistryHash: peerRegistryHash(peerRegistry),
    validatorDirectories,
    validatorUrls,
  }, 0o644);
  return { coordinatorDirectory, directory: root, networkId, validatorDirectories, validatorUrls };
}

export class TransactionMempool {
  #transactions = new Map();

  get size() { return this.#transactions.size; }

  has(id) { return this.#transactions.has(id); }

  values() { return this.take(this.#transactions.size); }

  add(transaction) {
    if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
      throw new Error("transaction must be an object");
    }
    if (Buffer.byteLength(canonicalJson(transaction)) > 64 * 1024) {
      throw new Error("transaction exceeds the mempool size limit");
    }
    const id = transactionId(transaction);
    if (this.#transactions.has(id)) throw new Error("transaction is already in the mempool");
    if (this.#transactions.size >= MAX_MEMPOOL_TRANSACTIONS) throw new Error("mempool is full");
    this.#transactions.set(id, structuredClone(transaction));
    return id;
  }

  take(limit = MAX_TRANSACTIONS_PER_BLOCK) {
    return [...this.#transactions.values()].slice(0, limit).map((transaction) =>
      structuredClone(transaction));
  }

  remove(transactions) {
    for (const transaction of transactions) this.#transactions.delete(transactionId(transaction));
  }
}

function proposalFields(block) {
  return {
    fallbackBeacons: block.fallbackBeacons,
    peerRegistryUpdate: block.peerRegistryUpdate,
    randomnessCommits: block.randomnessCommits,
    randomnessReveals: block.randomnessReveals,
    round: block.round,
    roundCertificate: block.roundCertificate,
    rewardClaims: [],
    safetyClaims: [],
    stateRoot: block.stateRoot,
    timestamp: block.timestamp,
    transactions: block.transactions,
    validatorRotation: block.validatorRotation,
  };
}

export class ValidatorReplica {
  #chain;
  #directory;
  #genesis;
  #wallet;
  #coordinator;
  #seenNonces = new Map();
  #validatorNonces = new Map();
  #validators;
  #mempool = new TransactionMempool();
  #peerUrls;
  #peerTransports;
  #peerTlsPins;
  #peerRegistry;
  #transportView;
  #transportWallet;

  constructor(directory) {
    this.#directory = resolve(directory);
    ({ chain: this.#chain } = loadChain(this.#directory));
    this.#wallet = readJson(join(this.#directory, "VALIDATOR-KEY.json"));
    this.#coordinator = readJson(join(this.#directory, "AUTHORIZED-COORDINATOR.json"));
    const genesis = readJson(join(this.#directory, "genesis.json"));
    this.#genesis = genesis;
    this.#validators = this.#chain.validatorMembers;
    const registry = this.#chain.peerRegistry;
    if (!registry) throw new Error("peer registry has no active version");
    this.#peerRegistry = registry;
    this.#transportWallet = readJson(join(this.#directory, "TRANSPORT-KEY.json"));
    this.#refreshTransportView();
    const pendingMembers = this.#chain.pendingValidatorRotation?.validators ?? [];
    const member = [...this.#validators, ...pendingMembers]
      .find(({ address }) => address === this.#wallet.address);
    if (!member || member.publicKey !== this.#wallet.publicKey) {
      throw new Error("validator key does not belong to this network");
    }
    const ownTransport = this.#transportView
      .find(({ validatorAddress }) => validatorAddress === this.#wallet.address)?.transport;
    if (!ownTransport) throw new Error("validator has no authenticated transport binding");
    if (ownTransport.address !== this.#transportWallet.address ||
        ownTransport.publicKey !== this.#transportWallet.publicKey) {
      throw new Error("validator transport key does not belong to the authenticated transport view");
    }
    for (const name of readdirSync(join(this.#directory, "mempool")).sort()) {
      if (/^[0-9a-f]{64}\.json$/.test(name)) this.#mempool.add(readJson(join(this.#directory, "mempool", name)));
    }
  }

  get address() { return this.#wallet.address; }
  get height() { return this.#chain.height; }
  get networkId() { return this.#chain.networkId; }
  get tipHash() { return this.#chain.tipHash; }
  get mempoolSize() { return this.#mempool.size; }
  get peerUrls() { return [...this.#peerUrls]; }
  get peerCount() { return this.#transportView.length; }
  get validatorCount() { return this.#validators.length; }

  validatorCountForHeight(height) {
    return this.#chain.validatorMembersForHeight(height).length;
  }

  #validatorSets(height) {
    const required = this.#chain.validatorMembersForHeight(height);
    const pending = this.#chain.pendingValidatorRotation;
    const previous = pending?.activationHeight === height ? this.#chain.validatorMembers : null;
    const accepted = new Map([...(previous ?? []), ...required]
      .map((member) => [member.address, member]));
    return { accepted, previous, required };
  }

  #requireSetQuorum(voters, members, label) {
    const addresses = new Set(members.map(({ address }) => address));
    const votes = [...voters].filter((address) => addresses.has(address)).length;
    const quorum = Math.floor((members.length * 2) / 3) + 1;
    if (votes < quorum) throw new Error(`${label} quorum not reached (${votes}/${quorum})`);
  }

  #refreshTransportView() {
    const activeByAddress = new Map(this.#chain.validatorMembers.map((member) =>
      [member.address, member]));
    this.#validators = [
      ...this.#genesis.validators
        .filter(({ address }) => activeByAddress.has(address))
        .map(({ address }) => activeByAddress.get(address)),
      ...[...activeByAddress.values()]
        .filter(({ address }) => !this.#genesis.validators.some((member) =>
          member.address === address)),
    ];
    this.#peerRegistry = this.#chain.peerRegistry;
    this.#transportView = buildValidatorTransportView({
      currentPeerRegistry: this.#peerRegistry,
      currentValidators: this.#validators,
      height: this.#chain.height,
      networkId: this.#chain.networkId,
      pendingRotation: this.#chain.pendingValidatorRotation,
    });
    this.#peerUrls = this.#transportView.map(({ url }) => url);
    this.#peerTransports = this.#transportView.map(({ transport }) => transport);
    this.#peerTlsPins = this.#transportView.map(({ tlsCertificateSha256 }) =>
      tlsCertificateSha256);
  }

  account(address) {
    if (!ADDRESS.test(address)) throw new Error("address is invalid");
    return { address, atomicBalance: this.#chain.balance(address).toString() };
  }

  authorize(auth, method, path, body) {
    return verifyPeerRequest({
      auth, body, method, networkId: this.networkId, path,
      seenNonces: this.#seenNonces, trustedPeer: this.#coordinator,
    });
  }

  authenticateResponse(requestNonce, result) {
    return createPeerResponse({ networkId: this.networkId, requestNonce, result, wallet: this.#wallet });
  }

  authenticateValidatorResponse(requestNonce, result) {
    return createPeerResponse({
      networkId: this.networkId, requestNonce, result, wallet: this.#transportWallet,
    });
  }

  peerAnnouncement() {
    return createPeerAnnouncement({
      height: this.height,
      networkId: this.networkId,
      registry: this.#peerRegistry,
      tipHash: this.tipHash,
    }, this.#transportWallet);
  }

  authorizeValidator(auth, method, path, body) {
    const index = this.#peerTransports.findIndex(({ address }) => address === auth?.signer);
    const peer = this.#peerTransports[index];
    if (!peer) throw new Error("gossip signer has no authenticated transport binding");
    authorizeTransportAction(this.#transportView[index], {
      currentHeight: this.height,
      path,
      payload: body,
      pendingRotation: this.#chain.pendingValidatorRotation,
    });
    if (!this.#validatorNonces.has(peer.address)) this.#validatorNonces.set(peer.address, new Map());
    return verifyPeerRequest({
      auth, body, method, networkId: this.networkId, path,
      seenNonces: this.#validatorNonces.get(peer.address), trustedPeer: peer,
    });
  }

  createValidatorRequest(path, body) {
    return createPeerRequest({
      body, networkId: this.networkId, path, wallet: this.#transportWallet,
    });
  }

  verifyValidatorResponse(index, auth, requestNonce, result) {
    return this.verifyValidatorResponseFrom(
      this.#peerTransports[index], auth, requestNonce, result,
    );
  }

  verifyValidatorResponseFrom(peer, auth, requestNonce, result) {
    return verifyPeerResponse({
      auth, networkId: this.networkId, requestNonce, result,
      trustedPeer: peer,
    });
  }

  peerDescriptor(index, url = this.#peerUrls[index]) {
    const entry = this.#transportView[index];
    if (!entry || typeof url !== "string") throw new Error("validator peer index is invalid");
    return structuredClone({ ...entry, url });
  }

  validatorAddressForPeerSigner(signer) {
    const index = this.#peerTransports.findIndex(({ address }) => address === signer);
    return index < 0 ? null : this.#transportView[index].validatorAddress;
  }

  peerAddress(index) { return this.#transportView[index]?.validatorAddress; }
  peerTlsCertificateSha256(index) { return this.#peerTlsPins[index] ?? null; }

  pendingTransactions() { return this.#mempool.values(); }

  stateSnapshotCandidate() {
    return createStateSnapshot(this.#chain, [this.#wallet]);
  }

  stateSnapshotAttestation({ height, snapshotHash }) {
    if (!Number.isSafeInteger(height) || height !== this.height ||
        !/^[0-9a-f]{64}$/.test(snapshotHash ?? "")) {
      throw new Error("snapshot attestation request is invalid");
    }
    const candidate = this.stateSnapshotCandidate();
    if (candidate.snapshotHash !== snapshotHash) {
      throw new Error("snapshot attestation does not match local finalized state");
    }
    return candidate.attestations[0];
  }

  validatorHandoffCandidate(proposal) {
    const pending = this.#chain.pendingValidatorRotation;
    if (!pending || pending.activationHeight !== proposal?.height) return null;
    const rebuilt = this.#chain.buildBlock(proposalFields(proposal));
    if (canonicalJson(rebuilt) !== canonicalJson(proposal)) {
      throw new Error("handoff proposal is not deterministic for this state");
    }
    this.#chain.validateProposal(proposal);
    return createValidatorHandoffCandidate({
      activationBlockHash: blockHash(proposal),
      activationHeight: proposal.height,
      activationStateRoot: proposal.stateRoot,
      networkId: this.networkId,
      nextValidators: pending.validators,
      previousValidators: this.#chain.validatorMembers,
    }, this.#wallet);
  }

  assembleValidatorHandoffCandidates(candidates, proposal) {
    if (this.validatorHandoffCandidate(proposal) === null) return null;
    const trustAnchor = {
      expectedNetworkId: this.networkId,
      trustedValidators: this.#genesis.validators,
    };
    const history = loadValidatorHandoffs(join(this.#directory, "handoffs"), trustAnchor);
    const merged = mergeValidatorHandoffCandidates(candidates, {
      expectedNetworkId: this.networkId,
      minimumActivationHeight: (history.lastHandoff?.activationHeight ?? 0) + 1,
      trustedValidators: history.trustedValidators,
    });
    if (merged.verified.activationHeight !== proposal.height ||
        merged.verified.activationBlockHash !== blockHash(proposal) ||
        merged.verified.activationStateRoot !== proposal.stateRoot) {
      throw new Error("validator handoff does not match the activation proposal");
    }
    return merged.handoff;
  }

  installFinalizedValidatorHandoff(handoff) {
    const block = this.#chain.blocks().find(({ height }) => height === handoff?.activationHeight);
    if (!block || block.hash !== handoff.activationBlockHash ||
        block.stateRoot !== handoff.activationStateRoot) {
      throw new Error("validator handoff activation block is not finalized locally");
    }
    const trustAnchor = {
      expectedNetworkId: this.networkId,
      trustedValidators: this.#genesis.validators,
    };
    const history = loadValidatorHandoffs(join(this.#directory, "handoffs"), trustAnchor);
    const known = history.handoffs.find(({ handoffHash }) => handoffHash === handoff.handoffHash);
    if (known) return { handoffHash: handoff.handoffHash, status: "known" };
    const installed = installValidatorHandoff(
      join(this.#directory, "handoffs"), handoff, trustAnchor,
    );
    return { ...installed, status: "installed" };
  }

  validatorHandoffHistory() {
    const trustAnchor = {
      expectedNetworkId: this.networkId,
      trustedValidators: this.#genesis.validators,
    };
    const history = loadValidatorHandoffs(join(this.#directory, "handoffs"), trustAnchor);
    return history.handoffs.map((handoff) => structuredClone(handoff));
  }

  installStateSnapshotCandidates(candidates) {
    const rootTrustAnchor = {
      expectedNetworkId: this.networkId,
      trustedValidators: this.#genesis.validators,
    };
    const history = loadValidatorHandoffs(
      join(this.#directory, "handoffs"), rootTrustAnchor,
    );
    const merged = mergeStateSnapshotCandidates(candidates, {
      expectedNetworkId: this.networkId,
      trustedValidators: history.trustedValidators,
    });
    if (merged.verified.height <= this.height) {
      throw new Error("state snapshot does not advance the validator");
    }
    const installed = installBlockStoreSnapshot(
      this.#directory, this.#genesis, merged.snapshot,
      { handoffs: history.handoffs, trustedValidators: this.#genesis.validators },
    );
    this.#chain = installed.chain;
    this.#refreshTransportView();
    return {
      height: this.height,
      snapshotHash: installed.snapshotHash,
      stateRoot: installed.stateRoot,
      tipHash: this.tipHash,
    };
  }

  blocksAfter(fromHeight, limit = 8) {
    if (!Number.isSafeInteger(fromHeight) || fromHeight < 1 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
      throw new Error("block range request is invalid");
    }
    return this.#chain.blocks().filter(({ height }) => height >= fromHeight).slice(0, limit);
  }

  expectedProposer(height = this.height + 1, round = 0) {
    return this.#chain.expectedProposer(height, round);
  }

  buildProposal() {
    const transactions = this.#mempool.take();
    if (transactions.length === 0) throw new Error("validator mempool is empty");
    const timestamp = Math.max(Date.now(), this.#chain.blocks().at(-1).timestamp);
    return this.#chain.buildBlock({ transactions, timestamp });
  }

  advanceProposal(proposal, nextRound, roundCertificate) {
    if (!proposal || !Number.isSafeInteger(nextRound) || nextRound !== proposal.round + 1) {
      throw new Error("next consensus round is invalid");
    }
    const advanced = this.#chain.buildBlock({
      ...proposalFields(proposal),
      round: nextRound,
      roundCertificate,
    });
    this.#chain.validateProposal(advanced);
    if (blockHash(advanced) !== blockHash(proposal)) {
      throw new Error("round advance changed the locked block value");
    }
    return advanced;
  }

  prepareCertificate(proposal, votes) {
    const rebuilt = this.#chain.buildBlock(proposalFields(proposal));
    if (canonicalJson(rebuilt) !== canonicalJson(proposal)) {
      throw new Error("prepare proposal is not deterministic for this state");
    }
    this.#chain.validateProposal(proposal);
    const uniqueVotes = new Map((votes ?? []).map((vote) => [vote.validator, vote]));
    const sets = this.#validatorSets(proposal.height);
    this.#requireSetQuorum(uniqueVotes.keys(), sets.required, "validator prepare");
    if (sets.previous) this.#requireSetQuorum(uniqueVotes.keys(), sets.previous, "old-set prepare");
    const hash = blockHash(proposal);
    for (const vote of uniqueVotes.values()) {
      const member = sets.accepted.get(vote.validator);
      if (!member || !verifyObject({ blockHash: hash }, vote.signature, member.publicKey, "BLOCK_PREPARE")) {
        throw new Error("validator prepare signature is invalid");
      }
    }
    return [...uniqueVotes.values()].sort((left, right) =>
      left.validator.localeCompare(right.validator));
  }

  commitVote(proposal, prepareCertificate) {
    const verified = this.prepareCertificate(proposal, prepareCertificate);
    if (!this.#validatorSets(proposal.height).accepted.has(this.address)) {
      throw new Error("local validator cannot vote at this height");
    }
    const hash = blockHash(proposal);
    const certificateHash = prepareCertificateHash(verified);
    const decisionPath = join(this.#directory, "commits",
      `${String(proposal.height).padStart(12, "0")}.json`);
    try {
      const decision = readJson(decisionPath);
      if (decision.blockHash !== hash) throw new Error("validator refuses a conflicting commit");
      const existingCertificateHash = decision.prepareCertificateHash ??
        prepareCertificateHash(decision.prepareCertificate);
      if (existingCertificateHash === certificateHash) return decision.vote;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const vote = commitVoteForBlock(proposal, verified, this.#wallet);
    writeAtomic(decisionPath, {
      blockHash: hash,
      prepareCertificate: verified,
      prepareCertificateHash: certificateHash,
      proposal,
      vote,
    });
    return vote;
  }

  finalizeProposal(proposal, prepareCertificate, votes) {
    const verifiedPrepare = this.prepareCertificate(proposal, prepareCertificate);
    const uniqueVotes = new Map((votes ?? []).map((vote) => [vote.validator, vote]));
    const sets = this.#validatorSets(proposal.height);
    this.#requireSetQuorum(uniqueVotes.keys(), sets.required, "validator commit");
    if (sets.previous) this.#requireSetQuorum(uniqueVotes.keys(), sets.previous, "old-set commit");
    const block = {
      ...proposal,
      certificate: [...uniqueVotes.values()].sort((left, right) =>
        left.validator.localeCompare(right.validator)),
      hash: blockHash(proposal),
      prepareCertificate: verifiedPrepare,
    };
    this.commit(block);
    return block;
  }

  submitTransaction(transaction) {
    const id = transactionId(transaction);
    if (this.#mempool.has(id)) return { status: "known", transactionId: id };
    this.#mempool.add(transaction);
    try {
      const timestamp = Math.max(Date.now(), this.#chain.blocks().at(-1).timestamp);
      this.#chain.validateProposal(this.#chain.buildBlock({
        transactions: this.#mempool.take(), timestamp,
      }));
      writeExclusive(join(this.#directory, "mempool", `${id}.json`), transaction, 0o600);
      return { status: "queued", transactionId: id };
    } catch (error) {
      this.#mempool.remove([transaction]);
      throw error;
    }
  }

  vote(block) {
    if (block.networkId !== this.networkId || block.height !== this.height + 1 ||
        block.previousHash !== this.tipHash ||
        block.proposer !== this.#chain.expectedProposer(block.height, block.round)) {
      throw new Error("proposal does not extend the validator state");
    }
    const rebuilt = this.#chain.buildBlock(proposalFields(block));
    if (canonicalJson(rebuilt) !== canonicalJson(block)) {
      throw new Error("proposal is not the deterministic block for this state");
    }
    this.#chain.validateProposal(block);
    if (!this.#validatorSets(block.height).accepted.has(this.address)) {
      throw new Error("local validator cannot vote at this height");
    }
    const hash = blockHash(block);
    const decisionPath = join(this.#directory, "prepares",
      `${String(block.height).padStart(12, "0")}-${String(block.round).padStart(2, "0")}.json`);
    try {
      const decision = readJson(decisionPath);
      if (decision.blockHash !== hash) throw new Error("validator refuses to equivocate at this height");
      return decision.vote;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const vote = voteForBlock(block, this.#wallet);
    writeExclusive(decisionPath, { blockHash: hash, proposal: block, vote });
    return vote;
  }

  preparedProposal(round = 0) {
    if (!Number.isSafeInteger(round) || round < 0 || round > MAX_CONSENSUS_ROUND) {
      throw new Error("prepare round is invalid");
    }
    const decisionPath = join(this.#directory, "prepares",
      `${String(this.height + 1).padStart(12, "0")}-${String(round).padStart(2, "0")}.json`);
    try {
      const decision = readJson(decisionPath);
      return structuredClone({ proposal: decision.proposal, vote: decision.vote });
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  lockedProposal() {
    const decisionPath = join(this.#directory, "commits",
      `${String(this.height + 1).padStart(12, "0")}.json`);
    try {
      const decision = readJson(decisionPath);
      return {
        blockHash: decision.blockHash,
        prepareCertificate: decision.prepareCertificate ?? null,
        proposal: decision.proposal ?? null,
        vote: decision.vote,
      };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  validateLockedProposal(lock, expectedValidator) {
    if (lock === null) return null;
    const member = this.#validatorSets(lock?.proposal?.height).accepted.get(expectedValidator);
    if (!member || !lock?.proposal || !Array.isArray(lock.prepareCertificate) ||
        lock.vote?.validator !== expectedValidator || lock.blockHash !== blockHash(lock.proposal)) {
      throw new Error("peer lock proof is invalid");
    }
    const verifiedPrepare = this.prepareCertificate(lock.proposal, lock.prepareCertificate);
    if (!verifyObject({
      blockHash: lock.blockHash,
      prepareCertificateHash: prepareCertificateHash(verifiedPrepare),
    }, lock.vote.signature, member.publicKey, "BLOCK_COMMIT")) {
      throw new Error("peer lock commit proof is invalid");
    }
    if (lock.proposal.height !== this.height + 1 || lock.proposal.previousHash !== this.tipHash) {
      throw new Error("peer lock does not extend the validator state");
    }
    const rebuilt = this.#chain.buildBlock(proposalFields(lock.proposal));
    if (canonicalJson(rebuilt) !== canonicalJson(lock.proposal)) {
      throw new Error("peer lock proposal is not deterministic");
    }
    this.#chain.validateProposal(lock.proposal);
    return structuredClone({
      prepareCertificate: verifiedPrepare,
      proposal: lock.proposal,
    });
  }

  timeout({ proposal, nextRound }) {
    if (!proposal || proposal.height !== this.height + 1 || proposal.previousHash !== this.tipHash ||
        !Number.isSafeInteger(nextRound) || nextRound !== proposal.round + 1) {
      throw new Error("timeout request does not extend the validator state");
    }
    const rebuilt = this.#chain.buildBlock(proposalFields(proposal));
    if (canonicalJson(rebuilt) !== canonicalJson(proposal)) {
      throw new Error("timeout proposal is not deterministic for this state");
    }
    this.#chain.validateProposal(proposal);
    const required = this.#chain.validatorMembersForHeight(proposal.height);
    if (!required.some(({ address }) => address === this.address)) {
      throw new Error("local validator cannot time out this height");
    }
    const height = proposal.height;
    const previousHash = proposal.previousHash;
    const lockedBlockHash = blockHash(proposal);
    const votePath = join(this.#directory, "commits", `${String(height).padStart(12, "0")}.json`);
    try {
      const decision = readJson(votePath);
      if (decision.blockHash !== lockedBlockHash) {
        throw new Error("validator refuses to unlock a different block value");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const timeoutPath = join(this.#directory, "timeouts",
      `${String(height).padStart(12, "0")}-${String(nextRound).padStart(2, "0")}.json`);
    try {
      const decision = readJson(timeoutPath);
      if (decision.blockHash !== lockedBlockHash) {
        throw new Error("validator refuses a conflicting timeout at this round");
      }
      return decision.vote;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const vote = timeoutForRound({
      blockHash: lockedBlockHash, networkId: this.networkId, height, previousHash, nextRound,
    }, this.#wallet);
    writeExclusive(timeoutPath, { blockHash: lockedBlockHash, height, nextRound, previousHash, vote });
    return vote;
  }

  observeRoundTimeout({ proposal, nextRound }, delayMs, now = Date.now()) {
    if (!proposal || proposal.height !== this.height + 1 || proposal.previousHash !== this.tipHash ||
        !Number.isSafeInteger(nextRound) || nextRound !== proposal.round + 1 ||
        !Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 30_000 ||
        !Number.isSafeInteger(now) || now < 0) {
      throw new Error("round timeout observation is invalid");
    }
    const rebuilt = this.#chain.buildBlock(proposalFields(proposal));
    if (canonicalJson(rebuilt) !== canonicalJson(proposal)) {
      throw new Error("timeout proposal is not deterministic for this state");
    }
    this.#chain.validateProposal(proposal);
    const blockHashValue = blockHash(proposal);
    const votePath = join(this.#directory, "commits",
      `${String(proposal.height).padStart(12, "0")}.json`);
    try {
      const decision = readJson(votePath);
      if (decision.blockHash !== blockHashValue) {
        throw new Error("validator refuses to time out a different locked value");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const observationPath = join(this.#directory, "timeouts",
      `${String(proposal.height).padStart(12, "0")}-${String(nextRound).padStart(2, "0")}-observed.json`);
    let observedAt = now;
    try {
      const observation = readJson(observationPath);
      if (observation.blockHash !== blockHashValue || observation.nextRound !== nextRound ||
          !Number.isSafeInteger(observation.observedAt) || observation.observedAt < 0) {
        throw new Error("validator refuses a conflicting timeout observation");
      }
      observedAt = observation.observedAt;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      writeExclusive(observationPath, {
        blockHash: blockHashValue,
        height: proposal.height,
        nextRound,
        observedAt,
        previousHash: proposal.previousHash,
      });
    }
    return Math.max(0, observedAt + delayMs - now);
  }

  commit(block) {
    if (block.height <= this.height) {
      const existing = this.#chain.blocks().find(({ height }) => height === block.height);
      if (existing?.hash === block.hash) return { height: this.height, status: "known" };
      throw new Error("committed block conflicts with validator state");
    }
    const verified = this.#chain.fork();
    verified.appendBlock(block);
    persistBlock(this.#directory, block, verified);
    this.#chain = verified;
    this.#refreshTransportView();
    this.#mempool.remove(block.transactions);
    for (const transaction of block.transactions) {
      rmSync(join(this.#directory, "mempool", `${transactionId(transaction)}.json`), { force: true });
    }
    return { height: this.height, status: "committed" };
  }
}

async function peerRequest(url, path, value, {
  maxResponseBytes, networkId, peer, tlsCertificateSha256 = null, wallet,
}) {
  const auth = createPeerRequest({ body: value, networkId, path, wallet });
  const response = await requestJson(`${url}${path}`, {
    body: { auth, payload: value },
    method: "POST",
    maxResponseBytes,
    tlsCertificateSha256,
  });
  if (!response.ok) throw new Error(response.body.error ?? `validator returned ${response.status}`);
  return verifyPeerResponse({
    auth: response.body.auth, networkId, requestNonce: auth.nonce,
    result: response.body.result, trustedPeer: peer,
  });
}

export class DistributedCoordinator {
  #chain;
  #directory;
  #mempool = new TransactionMempool();
  #peers;
  #peerTlsPins;
  #treasury;
  #wallet;
  #validators;
  #genesis;

  constructor(directory, validatorUrls) {
    this.#directory = resolve(directory);
    ({ chain: this.#chain } = loadChain(this.#directory));
    this.#treasury = readJson(join(this.#directory, "TREASURY-DEV-KEY.json"));
    this.#wallet = readJson(join(this.#directory, "COORDINATOR-KEY.json"));
    if (!Array.isArray(validatorUrls) || validatorUrls.length < 4) {
      throw new Error("four validator peer URLs are required");
    }
    this.#peers = [...validatorUrls];
    const genesis = readJson(join(this.#directory, "genesis.json"));
    this.#genesis = genesis;
    this.#validators = genesis.validators;
    const registryByValidator = new Map((genesis.peerRegistry?.peers ?? []).map((peer) =>
      [peer.validatorAddress, peer]));
    this.#peerTlsPins = this.#validators.map(({ address }) =>
      registryByValidator.get(address)?.tlsCertificateSha256 ?? null);
  }

  get consensusMode() { return "remote-validator-quorum"; }
  get height() { return this.#chain.height; }
  get mempoolSize() { return this.#mempool.size; }
  get networkId() { return this.#chain.networkId; }
  get tipHash() { return this.#chain.tipHash; }

  account(address) {
    if (!ADDRESS.test(address)) throw new Error("address is invalid");
    const transactions = this.#chain.blocks().flatMap((block) => block.transactions)
      .filter((transaction) => transaction.sender === address || transaction.recipient === address)
      .map((transaction) => ({ ...transaction, id: transactionId(transaction) }));
    const balance = this.#chain.balance(address);
    return { address, atomicBalance: balance.toString(), balance: formatNir(balance),
      nextNonce: this.#chain.nextNonce(address), transactions };
  }

  feeQuote(amount, fee = MIN_TRANSFER_FEE.toString()) {
    return quoteTransferFee(String(amount), String(fee));
  }

  #queueLocal(transaction) {
    const id = transactionId(transaction);
    if (this.#mempool.has(id)) return { status: "known", transactionId: id };
    this.#mempool.add(transaction);
    try {
      const timestamp = Math.max(Date.now(), this.#chain.blocks().at(-1).timestamp);
      const proposal = this.#chain.buildBlock({
        transactions: this.#mempool.take(), timestamp,
      });
      this.#chain.validateProposal(proposal);
    } catch (error) {
      this.#mempool.remove([transaction]);
      throw error;
    }
    return { status: "queued", transactionId: id };
  }

  async submitTransaction(transaction) {
    const queued = this.#queueLocal(transaction);
    const relays = await Promise.allSettled(this.#peers.map((_, index) =>
      this.#request(index, "/v1/mempool/transactions", transaction)));
    const relayedPeers = relays.filter(({ status }) => status === "fulfilled").length;
    const quorum = Math.floor((this.#peers.length * 2) / 3) + 1;
    if (relayedPeers < quorum) {
      if (queued.status === "queued") this.#mempool.remove([transaction]);
      throw new Error(`transaction durability quorum not reached (${relayedPeers}/${quorum})`);
    }
    return { ...queued, relayedPeers };
  }

  async #request(index, path, value) {
    return peerRequest(this.#peers[index], path, value, {
      networkId: this.networkId,
      maxResponseBytes: path === "/v1/snapshots/candidate"
        ? MAX_SNAPSHOT_BYTES + 64 * 1024 : undefined,
      peer: this.#validators[index],
      tlsCertificateSha256: this.#peerTlsPins[index],
      wallet: this.#wallet,
    });
  }

  async #synchronizePeer(index) {
    const status = await this.#request(index, "/v1/health", {});
    const expected = this.#validators[index];
    if (status.address !== expected.address || status.networkId !== this.networkId) {
      throw new Error("validator health identity does not match the configured peer");
    }
    if (!Number.isSafeInteger(status.height) || status.height < 0 || status.height > this.height) {
      throw new Error("validator height is incompatible with coordinator state");
    }
    if (status.height === this.height) {
      if (status.tipHash !== this.tipHash) throw new Error("validator tip conflicts with coordinator state");
      return 0;
    }
    const missing = this.#chain.blocks().filter(({ height }) => height > status.height);
    for (const block of missing) await this.#request(index, "/v1/blocks", block);
    return missing.length;
  }

  async #recoverPeerTransactions() {
    const responses = await Promise.allSettled(this.#peers.map((_, index) =>
      this.#request(index, "/v1/mempool", {})));
    const recovered = new Map();
    for (const response of responses) {
      if (response.status !== "fulfilled") continue;
      for (const transaction of response.value.transactions ?? []) {
        recovered.set(transactionId(transaction), transaction);
      }
    }
    const ordered = [...recovered.values()].sort((a, b) =>
      String(a.sender).localeCompare(String(b.sender)) ||
      (Number.isSafeInteger(a.nonce) && Number.isSafeInteger(b.nonce) ? a.nonce - b.nonce : 0) ||
      transactionId(a).localeCompare(transactionId(b)));
    let added = 0;
    for (const transaction of ordered) {
      try {
        if (this.#queueLocal(transaction).status === "queued") added += 1;
      } catch {
        // A Byzantine peer cannot make the coordinator accept an invalid pending transaction.
      }
    }
    return added;
  }

  async produceBlock() {
    await this.#recoverPeerTransactions();
    const transactions = this.#mempool.take();
    if (transactions.length === 0) throw new Error("mempool is empty");
    const syncResults = await Promise.allSettled(this.#peers.map((_, index) =>
      this.#synchronizePeer(index)));
    const available = syncResults.map((result, index) => result.status === "fulfilled" ? index : -1)
      .filter((index) => index >= 0);
    let round = 0;
    let roundCertificate = null;
    let proposal;
    let uniqueVotes;
    while (round <= MAX_CONSENSUS_ROUND) {
      proposal = this.#chain.buildBlock({
        transactions, timestamp: proposal?.timestamp ?? Date.now(), round, roundCertificate,
      });
      const results = await Promise.allSettled(available.map((index) =>
        this.#request(index, "/v1/proposals", proposal)));
      const votes = results.filter(({ status }) => status === "fulfilled")
        .map(({ value }) => value.vote);
      uniqueVotes = new Map(votes.map((vote) => [vote.validator, vote]));
      const quorum = Math.floor((this.#peers.length * 2) / 3) + 1;
      if (uniqueVotes.size >= quorum && uniqueVotes.has(proposal.proposer)) break;
      if (round === MAX_CONSENSUS_ROUND) {
        throw new Error(`remote finality quorum not reached (${uniqueVotes.size}/${quorum})`);
      }
      const nextRound = round + 1;
      const timeoutRequest = { proposal, nextRound };
      const timeoutResults = await Promise.allSettled(available.map((index) =>
        this.#request(index, "/v1/timeouts", timeoutRequest)));
      const timeouts = timeoutResults.filter(({ status }) => status === "fulfilled")
        .map(({ value }) => value.timeout);
      const uniqueTimeouts = new Map(timeouts.map((vote) => [vote.validator, vote]));
      const timeoutQuorum = Math.floor((this.#peers.length * 2) / 3) + 1;
      if (uniqueTimeouts.size < timeoutQuorum) {
        throw new Error(`round timeout quorum not reached (${uniqueTimeouts.size}/${timeoutQuorum})`);
      }
      roundCertificate = [...uniqueTimeouts.values()];
      round = nextRound;
    }
    const prepareCertificate = [...uniqueVotes.values()].sort((left, right) =>
      left.validator.localeCompare(right.validator));
    const commitResults = await Promise.allSettled(available.map((index) =>
      this.#request(index, "/v1/commits", { prepareCertificate, proposal })));
    const commits = commitResults.filter(({ status }) => status === "fulfilled")
      .map(({ value }) => value.vote);
    const uniqueCommits = new Map(commits.map((vote) => [vote.validator, vote]));
    const commitQuorum = Math.floor((this.#peers.length * 2) / 3) + 1;
    if (uniqueCommits.size < commitQuorum || !uniqueCommits.has(proposal.proposer)) {
      throw new Error(`remote commit quorum not reached (${uniqueCommits.size}/${commitQuorum})`);
    }
    const pendingRotation = this.#chain.pendingValidatorRotation;
    let handoff = null;
    if (pendingRotation?.activationHeight === proposal.height) {
      const history = loadValidatorHandoffs(join(this.#directory, "handoffs"), {
        expectedNetworkId: this.networkId,
        trustedValidators: this.#genesis.validators,
      });
      const candidates = commitResults
        .filter(({ status, value }) => status === "fulfilled" && value?.handoffCandidate)
        .map(({ value }) => value.handoffCandidate);
      const merged = mergeValidatorHandoffCandidates(candidates, {
        expectedNetworkId: this.networkId,
        minimumActivationHeight: (history.lastHandoff?.activationHeight ?? 0) + 1,
        trustedValidators: history.trustedValidators,
      });
      if (merged.verified.activationBlockHash !== blockHash(proposal) ||
          merged.verified.activationHeight !== proposal.height ||
          merged.verified.activationStateRoot !== proposal.stateRoot) {
        throw new Error("validator handoff does not match the coordinator activation proposal");
      }
      handoff = merged.handoff;
    }
    const block = {
      ...proposal,
      certificate: [...uniqueCommits.values()].sort((left, right) =>
        left.validator.localeCompare(right.validator)),
      hash: blockHash(proposal),
      prepareCertificate,
    };
    const verified = this.#chain.fork();
    verified.appendBlock(block);
    persistBlock(this.#directory, block, verified);
    this.#chain = verified;
    if (handoff) installValidatorHandoff(join(this.#directory, "handoffs"), handoff, {
      expectedNetworkId: this.networkId,
      trustedValidators: this.#genesis.validators,
    });
    this.#mempool.remove(transactions);
    const broadcasts = await Promise.allSettled(this.#peers.map((_, index) =>
      this.#request(index, "/v1/blocks", block)));
    if (handoff) {
      await Promise.allSettled(this.#peers.map((_, index) =>
        this.#request(index, "/v1/handoffs", handoff)));
    }
    return {
      blockHash: block.hash,
      committedPeers: broadcasts.filter(({ status }) => status === "fulfilled").length,
      height: block.height,
      round: block.round,
      transactions: transactions.map(transactionId),
      commits: uniqueCommits.size,
      prepares: uniqueVotes.size,
      votes: uniqueCommits.size,
      synchronizedPeers: syncResults.filter(({ status, value }) => status === "fulfilled" && value > 0).length,
    };
  }

  async createSnapshot() {
    const synchronization = await Promise.allSettled(this.#peers.map((_, index) =>
      this.#synchronizePeer(index)));
    const synchronized = synchronization.map((result, index) =>
      result.status === "fulfilled" ? index : -1).filter((index) => index >= 0);
    const quorum = Math.floor((this.#peers.length * 2) / 3) + 1;
    if (synchronized.length < quorum) {
      throw new Error(`snapshot synchronization quorum not reached (${synchronized.length}/${quorum})`);
    }
    const trustAnchor = {
      expectedNetworkId: this.networkId,
      trustedValidators: this.#validators,
    };
    let merged = null;
    for (const candidateIndex of synchronized) {
      try {
        const { snapshot } = await this.#request(candidateIndex, "/v1/snapshots/candidate", {});
        verifyStateSnapshotCandidate(
          snapshot, trustAnchor, this.#validators[candidateIndex].address,
        );
        const requests = await Promise.allSettled(synchronized.map((index) =>
          this.#request(index, "/v1/snapshots/attest", {
            height: snapshot.height, snapshotHash: snapshot.snapshotHash,
          })));
        const attestations = requests.filter(({ status }) => status === "fulfilled")
          .map(({ value }) => value.attestation);
        const assembled = { ...snapshot, attestations };
        const verified = verifyStateSnapshot(assembled, trustAnchor);
        merged = { snapshot: assembled, verified };
        break;
      } catch {
        // Try another independently authenticated validator as the state source.
      }
    }
    if (!merged) throw new Error("snapshot candidate quorum is not reached");
    const installed = installStateSnapshot(
      join(this.#directory, "snapshots"), this.#genesis, merged.snapshot, trustAnchor,
    );
    return {
      height: installed.height,
      signedValidators: merged.snapshot.attestations.length,
      snapshotHash: installed.snapshotHash,
      stateRoot: installed.stateRoot,
      synchronizedValidators: synchronized.length,
      tipHash: installed.tipHash,
    };
  }

  async faucet(recipient, amount = (10n * ATOMIC_UNITS).toString()) {
    const atomic = BigInt(amount);
    if (!ADDRESS.test(recipient) || atomic <= 0n || atomic > 10n * ATOMIC_UNITS) {
      throw new Error("invalid devnet faucet request");
    }
    if (this.account(recipient).transactions.length > 0) {
      throw new Error("devnet faucet is limited to one request per fresh address");
    }
    const transaction = createTransfer({
      wallet: this.#treasury, networkId: this.networkId, recipient,
      amount: atomic.toString(), nonce: this.#chain.nextNonce(this.#treasury.address),
    });
    const queued = await this.submitTransaction(transaction);
    return { ...queued, ...(await this.produceBlock()) };
  }
}
