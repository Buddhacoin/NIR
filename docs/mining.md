# How NIR mining works

NIR mining means producing or verifying a measurable contribution. It does not
mean leaving a computer to guess hashes for currency. Running the current demo
does not create valuable NIR; the public mining network does not exist yet.

## Bitcoin comparison

Bitcoin mining repeatedly hashes a candidate block while changing a nonce and
other mutable data. A block succeeds when its hash is below the current target.
The search is deliberately expensive and probabilistic; verification is cheap.
Its protocol purpose is useful: it orders transactions, resists double spends,
and makes history expensive to rewrite. The hash search itself does not solve a
separate scientific or engineering problem.

NIR separates those functions. Validators finalize payments, while progress
participants earn from reproducible capability, efficiency, safety, benchmark,
or fraud evidence. Randomness assigns evaluators after the contribution is
committed; randomness does not replace proof of a useful result.

## Choose a role

### 1. Capability author

Submit a model, algorithm, dataset method, or efficiency improvement. Commit
the complete artifact first. Later, randomly assigned operators run the frozen
baseline and candidate on hidden tasks. A reward is possible only for a new
world-frontier delta that clears every critical safety gate.

### 2. Reproduction operator

Provide compatible compute, lock an operator bond, receive randomly assigned
jobs, execute the sealed harness, and sign the measured result. A valid service
earns an evaluation share; conflicting signatures can destroy the bond.

### 3. Challenge author

Create procedurally generated, objectively gradable task families and commit
them before candidate assignment. A challenge earns only when independent
evaluation shows that it measures a useful capability and is not leaked,
duplicated, or easily memorized.

### 4. Safety evaluator

Run the approved critical-risk suite in the required containment environment.
An evaluator is paid for correct reproducible work, not for always saying a
model is safe. A single confirmed critical failure vetoes progress issuance.

### 5. Safety investigator

Privately commit evidence of a previously unknown critical failure. A future
random committee reproduces it. If confirmed, the unsafe candidate earns zero,
70 percent of its locked bond goes to the investigator, 10 percent is divided
among evaluators, and at least 20 percent is burned. The bounty creates no new
NIR and the same evidence cannot be paid twice.

### 6. Fraud challenger

Submit objective evidence of double-signing, a forged execution receipt,
duplicated lineage, or another consensus violation. Payment comes from the
offender's bond under a rule validators can recompute.

### 7. Payment node

Store and verify the chain, relay blocks and transactions, and optionally
propose blocks. This role does not require training a large model.

## Intended user flow

The future desktop miner must reduce participation to these steps:

1. install a reproducibly built NIR application;
2. create or open an encrypted post-quantum vault;
3. choose a role and view its hardware, bond, and expected costs;
4. download a signed container and a committed task;
5. run a local preflight that estimates time, energy, and maximum loss;
6. explicitly approve the job;
7. let the application submit commitments and receipts automatically;
8. see `pending`, `challenged`, `accepted`, or `rejected` with an explanation;
9. receive a reward only after the challenge window closes.

No participant should paste commands, private keys, or model secrets into a web
form. The production application needs sandboxing, hardware attestation,
automatic updates that require explicit approval, and a testnet mode with units
that have no monetary value.

## Run the current demonstration

The repository currently demonstrates local rules only:

```bash
npm run mine:demo
```

It constructs signed local blocks and evaluation receipts. It does not connect
to peers, perform real model training, earn exchangeable currency, or register
the computer as a production operator.
