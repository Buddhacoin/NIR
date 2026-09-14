# NIR Security Status

NIR is under active protocol development. The current local chain must not be
used to custody, sell, or represent assets of real monetary value.

Security reports may be opened as private GitHub security advisories once the
repository is public. Do not include private keys, seed material, personal data,
or an exploit against a live third-party system in a public issue.

## Security properties implemented

- ML-DSA-65 signatures for transactions and validator votes;
- native threshold ML-DSA-65 transaction authorization;
- AES-256-GCM encrypted key vaults using scrypt-derived keys and public backup
  manifests that contain no encrypted or private key material;
- SHA3-256 block hashes and full 256-bit address identifiers;
- domain-separated signatures and hashes;
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
   coordinator can recover. It still has a single block-assembly coordinator,
   no transport confidentiality or governed coordinator-key rotation, lock
   discovery between competing coordinators, fork recovery, snapshot sync, peer
   discovery, or partition-tested liveness. Proposers now rotate over repeated
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
   rotate with delayed activation and a joint transition certificate, but bond
   withdrawal delays and partition testing are still missing. A valueless local
   node now persists finalized blocks and verifies them by replay after restart;
   production database recovery and multi-node durability are still missing.
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
2. The local node persists each finalized block with a temporary-file rename and
   verifies the complete journal on restart. It still lacks a production
   database, checksummed snapshots, pruning, backup coordination, and automatic
   recovery from disk corruption or a failed write after in-memory finality.
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

This does not make NIR "quantum-proof." A future algorithmic break, software
bug, weak random-number generator, leaked endpoint key, compromised build, or
validator takeover can bypass sound mathematics. Before a testnet, NIR needs:

- versioned cryptographic suites and an on-chain migration mechanism;
- consideration of hybrid ML-DSA plus SLH-DSA signatures for algorithm diversity;
- known-answer and cross-implementation tests against FIPS 204 vectors;
- constant-time and side-channel review of the runtime implementation;
- reproducible builds and signed release artifacts.

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
