# NIR Security Status

NIR is under active protocol development. The current local chain must not be
used to custody, sell, or represent assets of real monetary value.

Security reports may be opened as private GitHub security advisories once the
repository is public. Do not include private keys, seed material, personal data,
or an exploit against a live third-party system in a public issue.

## Security properties implemented

- ML-DSA-65 signatures for transactions and validator votes;
- SHA3-256 block hashes and full 256-bit address identifiers;
- domain-separated signatures and hashes;
- `2N/3 + 1` quorum certificates with unique validator votes;
- atomic state transitions, account nonces, and balance checks;
- deterministic issuance with a 21 million NIR hard cap;
- duplicate progress-proof rejection;
- quorum-signed evaluation receipts bound to network, epoch, artifact, and score;
- deterministic world-frontier memory with model lineage and behavior commitments;
- linear treasury vesting by bounded block timestamps;
- limits on block bytes, transaction counts, reward counts, keys, signatures,
  and numeric input lengths.

## Open production blockers

### Critical

1. **No distributed consensus protocol.** Validators run in one local process.
   There is no network transport, consensus round, locked quorum certificate,
   fork recovery, or equivocation evidence.
2. **Evaluator execution is not yet remotely attested.** Receipts are signed and
   scores are recomputed, but the chain cannot prove the signer actually ran the
   committed model in the declared environment.
3. **Energy is self-reported.** Hardware attestation and independent metering do
   not exist yet.
4. **Verifier identities are not Sybil-resistant.** Three valid keys can still
   be controlled by one party.
5. **Capability memory is not yet enforced by the JavaScript chain.** The
   deterministic registry rejects known artifacts, behavior, weak-baseline
   games, and non-frontier scores, but its state root still needs to become part
   of consensus and signed evaluation receipts.

### High

1. Private keys exist as unencrypted in-memory demo objects. There is no wallet,
   hardware-key support, backup, recovery, or secure erasure.
2. Ledger state is not persisted transactionally and cannot recover from disk
   corruption or an interrupted write.
3. Payments are public. Confidential amounts, sender privacy, recipient privacy,
   and network-layer anonymity are not implemented.
4. There is no mempool, transaction admission policy, peer reputation, rate
   limiting, or denial-of-service protection at the network boundary.
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
