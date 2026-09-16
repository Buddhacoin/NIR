# NIR launch readiness

NIR is not a launched currency. The current repository is suitable for local,
valueless development only. Passing automated tests is necessary, but it is not
evidence that real funds are safe.

## Current gate: local devnet

Implemented and continuously tested:

- independent layer-one ledger, capped issuance, fees, bonds, and slashing;
- ML-DSA-65 accounts, encrypted vaults, and 2-of-3 recovery;
- separate validator processes with two-phase `prepare -> commit` finality;
- proposer replacement, durable timeouts and locks, authenticated catch-up;
- deterministic partition tests, 512 adversarial message schedules, and
  multi-height stateful fuzzing with restarts and validator rotations;
- a six-process live `4 → 4` validator-rotation rehearsal with pre-activation
  synchronization, dual quorums, handoff persistence, restart, and retirement;
- a local wallet preview and valueless mining demonstration.

This gate does not authorize custody, sale, exchange listing, or claims that NIR
has market value.

## Gate 1: public developer testnet

Required before inviting unknown operators:

- automated certificate issuance, renewal and revocation, multi-seed health
  selection, and production denial-of-service controls; signed seed discovery,
  bounded application ingress, pinned TLS 1.3, and quorum-signed endpoint and
  transport-identity rotation with on-chain rollback protection are implemented;
- a production database and operational recovery drills around the implemented
  quorum snapshots, tail replay, two-stage pruning, and portable backups;
  authenticated snapshot catch-up from multiple peers is implemented, while
  remote backup coordination remains; fsync-backed block
  writes, checksummed journal checkpoints, local redundancy, verified repair,
  key-free portable chain backups, and a full consensus-state root in every
  protocol-v7 block are implemented;
- reproducible signed releases, monitoring, incident response, and a documented
  testnet reset policy;
- versioned protocol upgrades governed by an on-chain activation rule;
- at least four validator and fallback-beacon operators controlled by genuinely
  independent organizations;
- an internal security review with every critical finding closed.

The developer testnet must remain explicitly valueless and resettable.

## Gate 2: incentivized evaluation testnet

Required before testing mining economics:

- remotely attested, reproducible evaluator execution without exposing model
  weights;
- independently generated hidden challenges, containment evidence, and
  calibrated safety thresholds;
- independently metered resource and energy evidence;
- production candidate bonds, evaluator and validator withdrawal delays, and
  tested dispute procedures;
- a public explorer, stable wallet builds, hardware-backed keys, recovery drills,
  and clear test-token disclosures;
- a sustained adversarial testnet and public bug-bounty program.

## Gate 3: mainnet

Required before NIR can carry real value:

- independent audits of consensus, cryptography, wallet, evaluator isolation,
  economics, and release infrastructure, with critical and high findings closed;
- a written safety and liveness specification plus model checking or an
  equivalent formal analysis of finality and validator-set transitions;
- rehearsed emergency communication and client-upgrade procedures that cannot
  silently rewrite balances, supply, or finalized history;
- public genesis inputs, allocation addresses, vesting commitments, binaries,
  source hashes, and an independently reproducible genesis ceremony;
- a long-running multi-operator testnet with no unresolved consensus failure,
  loss of funds, or critical evaluator bypass;
- jurisdiction-specific legal review for distribution, privacy, sanctions,
  consumer disclosures, and exchange access.

Mainnet is a gate-based decision, not a date declared by the repository owner.
No single developer or company should be able to waive these requirements.

## Planning estimate, not a promise

With a funded, experienced protocol team working in parallel, a public valueless
developer testnet could plausibly follow in roughly 1-2 months. An incentivized
evaluation testnet is more realistically a 3-6 month milestone. An audited
mainnet should be treated as at least a 9-18 month program, and longer if formal
analysis, independent infrastructure, or evaluator attestation exposes design
changes. A solo development effort has no responsible fixed date.
