# How NIR mining works

Running an intelligence-mining role and joining the active validator finality
set are separate operations. A selected or bonded validator still needs an
authorized rotation. Protocol v30 implements testnet-gated validator exit and
bond withdrawal with a provisional 64-block cooldown; it is not yet
production-audited or a final mainnet economic parameter.
Operators deploying a validator should use the public, non-secret
[Mac/Linux deployment wizard](validator-deployment.md).

NIR mining means producing or verifying a measurable contribution. It does not
mean leaving a computer to guess hashes for currency. Running the current demo
does not create valuable NIR; the public mining network does not exist yet.

Mac users should begin with the beginner-safe
[`miner-quickstart-macos.md`](miner-quickstart-macos.md) and the guided
`npm run mine:wizard`. The complete evidence path and the experimental boundary
for connecting a local model, desktop application, or remote API are documented in
[`intelligence-verification-flow.md`](intelligence-verification-flow.md).

## Choose a role

### 1. Capability author

Submit a model, algorithm, dataset method, or efficiency improvement. Commit
the complete artifact, its metadata-independent canonical content digest, and
its bounded parent lineage first. Later, randomly assigned operators run the
frozen baseline and candidate on hidden tasks. A reward is possible only for a
new world-frontier delta that clears every critical safety gate.

The exact candidate id must first carry a finalized 1 NIR progress bond. The
author or a consenting sponsor can pay it. After a valid reward it remains
locked with that reward for a 64-finalized-block objective fraud window, then
refunds; otherwise it burns when admission expires after 1,024 blocks. An
honest timeout is not exempt. An unbound bond receives no committee and is
reclaimed only after 64 blocks, preventing free pre-admission committee probing.
This raises the cost of multi-key grinding
but does not prevent a well-funded participant from purchasing multiple tries.

Every rewarded block has one fixed scheduled budget, shared proportionally by
all accepted proof scores in that block. Splitting work across more funded keys,
candidate ids, or machines does not create another budget, and reward blocks
must remain at least ten minutes apart. Allocation is canonical and independent
of claim order; near the supply cap the final budget is truncated to the
remaining mining pool exactly. These rules limit emission, not market power. A
well-funded organization may still submit many distinct bonded improvements,
and validators can censor competing claims so that the included set divides the
budget differently. Exact canonical content and an already-recorded frontier
delta cannot be rewarded twice, while semantically equivalent but genuinely
different representations remain an explicit limitation of the bounded
canonicalizer and evaluator policy.

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
committee reproduces it. The candidate bond is finalized in block H; a quorum
of validators commits hidden randomness contributions in H+1 and reveals them
in H+2; the committee is derived from their combined contributions. A valid
report can be included no earlier than H+3 and must carry signatures from that complete
assigned committee. If confirmed, the unsafe candidate earns zero,
70 percent of its locked bond goes to the investigator, 10 percent is divided
among evaluators, and at least 20 percent is burned. The bounty creates no new
NIR and the same evidence cannot be paid twice.

If a randomness contributor commits and then misses its reveal deadline, every
node records the signer as a non-revealer and returns the candidate bond. Once
the validator has registered its signed on-chain bond, that objective record
burns one percent of its remaining bond. A balance below the required minimum
cannot contribute to later randomness rounds.

### 6. Fraud challenger

Submit objective evidence of double-signing, a forged execution receipt,
duplicated lineage, or another consensus violation. Payment comes from the
offender's bond under a rule validators can recompute.

### 7. Payment node

Store and verify the chain, relay blocks and transactions, and optionally
propose blocks. This role does not require training a large model.

## AI agents do not inherit mining authority

The planned payment mandate for a software agent cannot submit a candidate,
author a hidden challenge, evaluate work or collect a mining reward. Mining
requires a separate future contributor mandate, key, bond, role and assignment
lifecycle. Direct reuse of a payment delegate, controller set or candidate key
as its evaluator must fail where the relationship is objectively visible.

An agent-signed claim is not evidence of useful work. Fresh post-commit
assignment, reproducible execution receipts, independent evaluation, safety
results, a dispute window and reward escrow remain required. Hidden common
ownership and organizational collusion cannot be inferred reliably from keys
alone and remain operator-disclosure and independent-review responsibilities.
The broader fail-closed account model is specified in
[`agent-mandates.md`](agent-mandates.md). Its isolated Stage 2 JavaScript and
Rust model covers only escrowed payments to allowed payees under transfer,
total, fee and expiry limits, with owner revoke/expiry close and preverified
authorization. It grants no mining authority. Protocol-v26 chain rules, signed
schemas, proofs, simulation and wallet/signer support are not implemented.

## Intended user flow

The future desktop miner must reduce participation to these steps:

1. install a reproducibly built NIR application;
2. create or open an encrypted post-quantum vault;
3. choose a role and view its hardware, bond, and expected costs;
4. download a signed container and a committed task;
5. run a local preflight that estimates time, energy, and maximum loss;
6. explicitly approve the job;
7. let the application submit the signed on-chain commitment, wait for the
   next finalized challenge and assigned evaluator committee, then submit the
   bundle-backed receipts automatically;
8. see `pending`, `challenged`, `accepted`, or `rejected` with an explanation;
9. receive a reward only after the challenge window closes.

No participant should paste commands, private keys, or model secrets into a web
form. The production application needs sandboxing, hardware attestation,
automatic updates that require explicit approval, and a testnet mode with units
that have no monetary value.

## Run the current demonstration

The repository currently demonstrates local rules only:

```bash
npm run mine:wizard
npm run mine:preflight
npm run mine:demo
```

It constructs signed local blocks and evaluation receipts. It does not connect
to peers, perform real model training, earn exchangeable currency, or register
the computer as a production operator.

The wizard also exposes a separate developer-only adapter handshake check.
That option is not a mining role and does not establish intelligence, safety,
energy attestation, chain admission, or reward eligibility.

The local consensus rejects reuse of an already accepted canonical content
commitment even when the submitter key, package hash, metadata and evaluation
transcript change. This is not a claim that NIR can identify semantically copied
ideas or inspect private weights: isolated evaluators must recompute and attest
the bounded [`nir-model-content-v1`](model-content.md) digest, and distinct
commitments can still conceal related work.

## Connecting today

There is currently no public NIR testnet to connect to. The repository has no
bootstrap peer address, public job queue, faucet, mining pool, or downloadable
production miner. Anyone claiming to sell access or promising mining income at
this stage is not operating an official NIR service.

For developers, the current local sequence is:

```bash
git clone https://github.com/Buddhacoin/NIR.git
cd NIR
npm run test:chain
npm run mine:demo
```

Public source availability does not make the local demo a public network or a
mining service. Non-technical participation begins only with a signed desktop
release and public testnet.

## Connecting after testnet launch

The application will need a published network manifest containing the network
identifier, genesis hash, protocol version, signed release hash, and several
independent bootstrap peers. A person will then:

1. download the signed application from more than one published source;
2. verify the release signature automatically;
3. select `NIR testnet` and verify its displayed genesis fingerprint;
4. create an encrypted vault or open an existing one;
5. synchronize headers and independently validate the chain;
6. request valueless test units from the faucet if a role requires a bond;
7. choose a role and pass its local hardware preflight;
8. register the role key and external operator credentials where required;
9. receive assignments only after their commitments are finalized;
10. submit signed results and watch the challenge window.

Exact server names, ports, genesis hashes, and download URLs do not exist yet
and must never be invented in advance. They will be published and committed in
the testnet network manifest.
