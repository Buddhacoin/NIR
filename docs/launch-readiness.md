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
- a bounded executable consensus model aligned with the implementation, plus
  differential tests for round changes, locks, finality and validator rotation;
- a six-process live `4 → 4` validator-rotation rehearsal with pre-activation
  synchronization, simultaneous old/new outages, dual quorums, authenticated
  handoff plus endpoint-topology recovery, restart, and retirement;
- snapshot recovery across two ordered validator generations, with exact
  activation-block binding and one-block journal-tail replay;
- a local wallet preview and valueless mining demonstration;
- a loopback-only, exact-origin wallet bridge with per-request terminal approval,
  encrypted-vault password entry, replay protection, and no broadcast authority;
- an end-to-end HTTP test that creates a vault, funds it with valueless faucet
  units, obtains a fee quote, signs through the bridge, submits separately,
  finalizes a block, checks both balances, and rejects transaction replay;
- verified wallet- and node-package installers that refuse existing
  destinations, write source, artifact, signer, and release provenance after
  safe extraction, and reverify the complete installed file set.
- a protocol-gated bounded native-asset state machine with immutable lifetime
  caps, quorum-signed state or non-existence proofs, proof-bound simulation and
  offline signing; this remains a local developer feature, not an audited asset
  platform.

This gate does not authorize custody, sale, exchange listing, or claims that NIR
has market value.

## Gate 1: public developer testnet

Required before inviting unknown operators:

- production certificate issuance and external edge denial-of-service controls
  remain. Locally implemented are multi-seed signed discovery, bounded ingress,
  pinned TLS 1.3, quorum-signed certificate history, one-time genesis-pinned
  bootstrap, renewal overlap, revocation, rollback protection and controlled
  live TLS-context reload that retains the previous context on failure;
- production-equivalent deployment and drills remain. The repository now has
  fsync-backed redundant journals, quorum snapshots, authenticated catch-up,
  tail replay, two-stage pruning, signed multi-operator backup receipts,
  isolated restore drills, automated health records, bounded online integrity
  scrubbing and crash-resumable verified repair. These local mechanisms do not
  prove that remote operators or their infrastructure are independent;
- platform-signed native installers, incident response and a documented
  production incident process remain. A non-destructive testnet-reset planning
  drill, deterministic post-quantum signed source manifests, byte-reproducible
  `.nirpkg` wallet/node containers, backup health and integrity-health output
  are implemented locally;
- versioned protocol upgrades governed by a delayed on-chain activation rule
  are implemented locally; multi-operator upgrade and rollback drills remain;
- at least four validator and fallback-beacon operators controlled by genuinely
  independent organizations;
- an internal security review with every critical finding closed.

The developer testnet must remain explicitly valueless and resettable.

### Next measurable exit work

Code work is accepted against this gate only when it closes one of these
remaining checks and adds a reproducible failure test:

1. independent operators deploy the implemented certificate lifecycle and
   demonstrate issuance, renewal, revocation, replay rejection, restart and
   rotation on separate hosts;
2. a documented reset and incident drill preserves the published genesis and
   makes any destructive testnet action explicit; signed quorum reset planning
   and an isolated non-destructive drill are implemented locally, while a real
   multi-operator incident exercise remains;
3. packaged node and wallet builds are installed and reverified on supported
   platforms without trusting the download location; portable `.nirpkg`
   installation is implemented locally, while platform-signed native packaging
   and cross-platform release rehearsal remain;
4. four independently administered operators complete discovery, rotation,
   backup and recovery drills on separate hosts;
5. the internal critical findings have either executable closure evidence or a
   clearly external dependency that code alone cannot satisfy.

Items 1–3 can advance in this repository. Item 4 requires real independent
operators and infrastructure. External review is required before item 5 can be
declared closed; adding more local tests alone is not sufficient.

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
