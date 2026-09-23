# NIR Security Status

NIR is under active protocol development. The current local chain must not be
used to custody, sell, or represent assets of real monetary value.

Operator launch gates, commands, artifacts, machine-verifiable evidence, and
external manual criteria are indexed in
[`docs/public-testnet-gates.md`](docs/public-testnet-gates.md).

Security reports may be opened as private GitHub security advisories once the
repository is public. Do not include private keys, seed material, personal data,
or an exploit against a live third-party system in a public issue.

## Security properties implemented

- ML-DSA-65 signatures for transactions and validator votes;
- native threshold ML-DSA-65 transaction authorization;
- AES-256-GCM encrypted key vaults using scrypt-derived keys and public backup
  manifests that contain no encrypted or private key material; vault parsing
  enforces canonical encodings and strict sizes, validates the complete key
  pair before encryption, and clears the derived AES key buffer after use;
- SHA3-256 block hashes and full 256-bit address identifiers;
- domain-separated signatures and hashes;
- consensus keys separated from P2P transport identities, with a quorum-signed,
  hash-linked peer registry, on-chain active-registry commitment, and
  height-gated transport-key/endpoint rotation;
- built-in TLS 1.3 validator serving and certificate-pinned HTTPS clients, with
  certificate fingerprints governed by the finalized peer registry;
- signed peer discovery bound to the active on-chain registry commitment;
- ML-DSA-authenticated health and synchronization responses for both
  coordinator-to-validator and validator-to-validator traffic; public health
  JSON is monitoring information and is never a consensus input;
- bounded token-bucket ingress, request and response bodies, connections,
  headers, request duration, and keep-alive time;
- fsync-backed block persistence with checksummed checkpoints, redundant journal
  copies, verified startup repair, and private-key-free chain backup exports;
- a deterministic full-state root in genesis and every block, covering balances,
  nonces, issuance, burns, candidate and validator bonds, faults, validator-set
  transitions, peer registry, safety evidence, and capability-memory state;
- canonical full-state snapshot serialization with a separate content hash,
  recomputed state and capability-memory roots, active-set binding, and unique
  `2N/3 + 1` ML-DSA validator attestations;
- multi-source snapshot agreement with same-height conflict detection, atomic
  redundant staging, verified repair, size and symlink limits, and rollback
  protection;
- coordinator-authenticated snapshot candidate and hash-attestation RPCs where
  each validator rebuilds local state before signing and only one peer transfers
  the full bounded snapshot;
- `2N/3 + 1` quorum certificates with unique validator votes;
- disjoint evaluator and consensus key/operator registries;
- an operator-security prototype with credentials from two independent
  authorities, minimum bonds, unique committee selection, and double-sign
  evidence;
- a zero-issuance safety-bounty settlement that burns at least 20 percent of an
  unsafe candidate's bond, making self-reported vulnerability farming
  economically negative even across several addresses;
- candidate bonds, safety settlements, payouts, evidence replay protection, and
  burned supply persisted as atomic chain state;
- safety committees derived after candidate commitment from a validator-quorum
  commit/reveal round, with consensus rejecting unmatched reveals and receipts
  from any substituted evaluator set;
- deterministic non-reveal fault records and candidate-bond refunds when a
  committed randomness round is sabotaged;
- fallback randomness assembled from independently signed authority shares,
  with the aggregate recomputed by every node;
- delayed bonded finality-set rotation, including a joint old/new quorum on the
  activation block;
- atomic state transitions, account nonces, and balance checks;
- deterministic issuance with a 21 million NIR hard cap;
- reward epochs advance only on accepted progress and are rate-limited;
- duplicate progress-proof rejection;
- quorum-signed evaluation receipts bound to network, epoch, artifact, and score;
- genesis-approved safety-policy commitments and per-run critical-failure veto;
- deterministic world-frontier memory with model lineage and behavior commitments;
- world-memory roots committed in genesis, blocks, and evaluation transitions;
- linear treasury vesting by bounded block timestamps;
- limits on block bytes, transaction counts, reward counts, keys, signatures,
  and numeric input lengths.

## Open production blockers

### Critical

1. **No production distributed consensus protocol.** A localhost prototype now
   separates four validator keys into independent processes, independently
   executes proposals, persists anti-equivocation decisions, and collects a
   remote quorum certificate. Coordinator calls and validator responses now use
   pinned, replay-resistant ML-DSA identities, and lagging replicas can replay
   missing finalized blocks before voting. Validator transaction ingress now
   uses authenticated gossip and durable local pools that a restarted
   coordinator can recover. The elected validator can now assemble a normal
   block, gather peer votes, and broadcast finality without the coordinator.
   Restarted validators can also fetch bounded, mutually authenticated block
   ranges from validator peers and independently replay every certificate and
   state transition without the coordinator.
   Validator peers now independently test leader reachability, gather a signed
   timeout quorum, preserve the locked value, and delegate production to the
   replacement proposer without the coordinator. Durable timeout observations
   now survive restart, back off exponentially by round, and require a second
   failed probe before signing. This is not yet a latency-adaptive production
   pacemaker. Replacement leaders query authenticated peer locks. Every accepted
   report contains a verified prepare quorum plus the reporting validator's
   commit signature, so an uncorroborated claim cannot choose a value. View
   change selects the greatest certified round and fails closed on conflicting
   values at the same greatest round. Finality now uses separate prepare and
   commit certificates; commit signatures bind the exact prepare certificate,
   while split prepare votes remain round-local and can safely move to a later
   certified round.
   Non-loopback entries in the signed peer registry must use HTTPS. The node can
   terminate TLS 1.3 itself, and clients verify the exact certificate fingerprint
   and validity period. The active registry hash is committed
   in genesis and every block; a node rejects a local registry rollback that no
   longer matches finalized state. Quorum-authorized certificate issue records,
   bounded renewal overlap, revocation, lifecycle-history propagation, one-time
   bootstrap, and live certificate reload are implemented. Certificate issuance,
   private-key custody, and deployment remain operator responsibilities.
   A joining node can query multiple distinct authenticated seeds for a signed
   peer registry, rejects any response whose hash is not anchored in its local
   chain checkpoint, tolerates unavailable seeds, and fails closed on conflicting
   valid histories. Quorum-authenticated snapshot selection, atomic snapshot
   installation, journal-tail replay, and topology-handoff recovery are
   implemented. There is no automatic fork choice between conflicting finalized
   histories. Independent public bootstrap operation and hostile multi-host
   recovery drills remain external launch gates. Deterministic
   `2+2` and `3+1` HTTP partition schedules now verify quorum safety and recovery,
   a split-prepare regression verifies later-round liveness, and 512 seeded
   schedules exercise delayed, dropped, reordered, and replayed messages from
   an equivocating proposer. Multi-height stateful schedules additionally mix
   partitions, replay, corrupted signatures, journal-backed restarts, full-chain
   replay, and delayed joint-quorum validator rotations. Coverage-guided fuzzing,
   independent review, and a formal safety/liveness proof remain.
   Proposers now rotate over repeated
   on-chain quorum timeout certificates while votes stay bound to one immutable
   execution-value hash.
2. **Evaluator execution is not yet remotely attested.** Receipts are signed and
   scores are recomputed, but the chain cannot prove the signer actually ran the
   committed model in the declared environment.
3. **Energy is self-reported.** Hardware attestation and independent metering do
   not exist yet.
4. **Operator identity and randomness are not production-ready.** The prototype
   can verify multiple external credentials and slash provable double-signing,
   but genesis still accepts self-asserted operator IDs. Safety committee
   assignment now uses an on-chain validator-quorum commit/reveal round. Its
   last revealer can still withhold after seeing other reveals. The chain detects
   and penalizes this, then combines independently signed fallback shares. A
   runnable authority service persists decisions to resist restart equivocation,
   but independent organizations have not deployed or audited it. Finality sets
   rotate with delayed activation and a joint transition certificate. Local
   partition, restart, snapshot, and recovery paths are exercised, and redundant
   journals, snapshots, signed backups, restore receipts, and recovery-state
   commitments are implemented. Bond withdrawal delays, independent-host fault
   drills, external monitoring, and deployment-specific storage qualification
   remain open.
5. **Safety coverage is incomplete.** Consensus enforces the selected policy and
   veto rule, but the first policy does not yet have production-grade hidden
   suites, calibrated danger thresholds, or containment attestations.

### High

1. Private keys exist as unencrypted in-memory demo objects after a vault is
   unlocked. The native CLI wallet and interface preview do not yet provide
   hardware-key support, memory locking, or secure erasure. The encrypted vault
   and recovery-manifest primitives have not received an independent
   cryptographic audit.
   The terminal tool suppresses echo and refuses passwords from arguments, but
   the JavaScript runtime can still retain secret material in process memory.
   Password-derived encryption is only as resistant as the chosen passphrase;
   the 12-character input floor is not a claim of 128-bit entropy.
2. Nodes verify a finalized block on an isolated state copy before synchronously
   persisting redundant journals and checksummed checkpoints, then replace live
   memory. Startup automatically repairs one damaged copy after full consensus
   replay, advances stale checkpoints, and fails closed if both copies are lost.
   Key-free portable chain exports support backups to a separate device.
   Protocol version 6 commits the complete deterministic state root. Canonical
   snapshot export, trust-anchored quorum verification, typed in-memory restore,
   root revalidation, and post-checkpoint block continuation are implemented.
   Multi-source selection, atomic redundant disk staging, signed snapshot RPC,
   authenticated source collection, joining-node installation,
   validator-rotation proofs, journal-tail replay, two-stage pruning, signed
   backup receipts, and automated restore drills are implemented. A
   production-equivalent database/storage qualification, independent remote
   backup operators, capacity planning, monitoring, and external review remain.
3. Payments are public. Confidential amounts, sender privacy, recipient privacy,
   viewing keys, payment disclosures, and network-layer privacy are not
   implemented. No post-quantum shielded-proof construction has been selected.
4. Validator mempools are bounded, disk-backed, authenticated during gossip,
   independently revalidated, and protected by a basic per-source ingress rate
   limit. They still lack fee-priority admission, peer reputation, adaptive
   denial-of-service controls, privacy-preserving origin handling, and robust
   behavior behind load balancers or changing network addresses.
5. There has been no independent audit, formal verification, or adversarial
   public testnet.

## Quantum-attacker review

ML-DSA-65 is the category-3 parameter set of the NIST FIPS 204 post-quantum
signature standard. It is intended to resist known attacks by large-scale
quantum computers. SHA3-256 remains relevant in the quantum model, although
Grover-style search reduces its ideal preimage margin to roughly 128 bits. NIR
keeps the complete 256-bit hash in addresses rather than truncating it.

NIR's current TLS 1.3 certificate keys are conventional and do not provide
post-quantum confidentiality. A future quantum adversary could recover such a
TLS private key or decrypt recorded sessions. Consensus control messages remain
authenticated at the application layer with ML-DSA-65, including health and
synchronization state, so breaking TLS alone must not authorize a vote, block,
peer-registry change, or fabricated replica state. Never send model weights,
vault material, or other long-lived secrets over the current transport. Hybrid
or post-quantum TLS key establishment is required before production.

This does not make NIR "quantum-proof." A future algorithmic break, software
bug, weak random-number generator, leaked endpoint key, compromised build, or
validator takeover can bypass sound mathematics. Before any real-value network,
NIR needs:

- versioned cryptographic suites and an on-chain migration mechanism;
- consideration of hybrid ML-DSA plus SLH-DSA signatures for algorithm diversity;
- known-answer and cross-implementation tests against FIPS 204 vectors;
- constant-time and side-channel review of the runtime implementation;
- reproducible builds and signed release artifacts.

The detailed layer-by-layer model is documented in
[`docs/quantum-security.md`](docs/quantum-security.md).

## Audit log

### 2026-09-13 — internal adversarial review

Fixed during review:

- treasury allocation was described as vested but was immediately spendable;
- height-based vesting could be accelerated by rapidly producing blocks;
- account addresses truncated SHA3-256 to 160 bits;
- signatures lacked explicit protocol-purpose domain separation;
- signed transfers were replayable across networks with matching account state;
- a deliberately weak baseline could manufacture apparent progress;
- progress scores were accepted without quorum-signed evaluation receipts;
- one evaluator could overweight a result by submitting multiple runs;
- unattested baseline energy could distort the efficiency score;
- empty blocks could consume issuance epochs and accelerate reward reduction;
- capability memory existed outside consensus and could diverge between nodes;
- colluding validators could compress many reward epochs into a short interval;
- evaluators and consensus validators shared the same keys and operator role;
- aggregate capability gains could compensate for a critical safety failure;
- submitters could name an unapproved safety policy in an evaluation receipt;
- block, number, key, signature, and collection sizes were insufficiently bounded;
- future block timestamps were not bounded;
- reward aggregation mishandled multiple proofs from the same contributor;
- evaluator artifact identifiers accepted arbitrary non-hash strings;
- evaluation-family regressions could be hidden by aggregate improvement;
- evaluator text, energy, case, and repetition inputs lacked resource limits;
- cryptographic key type was trusted from a label rather than inspected;
- mutable in-process maps and retained block objects exposed consensus state.

The open production blockers above remain unresolved and are more important
than adding additional token features.
