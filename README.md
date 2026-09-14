# NIR Protocol

NIR is a monetary protocol in which new currency is issued for
**verified progress in machine intelligence**, not for raw computation alone.

This repository is the first executable protocol sketch. It is deliberately
not a tradable token, investment product, wallet, or mainnet.

NIR is an independent layer-one blockchain, not a token issued by another
network. It requires a native wallet for its addresses, ML-DSA-65 signatures,
network rules, encrypted vaults, and multisignature recovery. The repository
already contains the cryptographic vault core; a reviewed desktop/mobile wallet
and hardware-key integration are still future work.

## Core idea

A candidate contribution competes against a frozen baseline on hidden tests.
It may earn an epoch reward only when independent verification shows:

- a positive capability gain;
- breadth beyond one memorized test;
- reproducibility by independent nodes;
- no unacceptable safety regression;
- novelty relative to earlier accepted work;
- declared compute energy backed by future hardware attestations.

Raw compute never creates money by itself. Rewards are shared among accepted
contributions according to their verified progress score, with an efficiency
adjustment for the energy used.

Evaluation and block finality use separate ML-DSA-65 key registries. Their
operator identities must be unique and disjoint in the genesis configuration.

## Why organizations use NIR

An organization does not participate only for newly issued NIR. An accepted
proof can provide:

- independently reproducible evidence that a model or method is better;
- a versioned safety clearance recognized by an open evaluator network;
- a way to license verified capability without publishing private weights;
- reputation and eligibility for customers that require independent evidence;
- NIR for a contribution that moves the measured world frontier.

These benefits have value only if users, AI services, and buyers demand the
verification network. A token cannot manufacture adoption by itself.

## Ways people can earn

NIR must not become money only laboratories can issue. The protocol is being
designed around distinct, measurable contributions:

- authors prove a new capability or a real efficiency improvement;
- independent compute operators reproduce a submitted result;
- challenge authors create fresh, objectively gradable tasks;
- safety evaluators verify that a candidate clears an approved policy;
- safety investigators prove a previously unknown critical failure;
- fraud challengers prove forged evaluation, duplicated lineage, or
  double-signing;
- node operators validate and relay ordinary payments.

Positive capability proofs and vulnerability discoveries are different reward
classes. A laboratory can earn for safe progress. An investigator can earn a
bounded security bounty for a reproducible failure even though the unsafe
model itself receives no progress reward. Bounties must come from a declared
security pool or slashed bonds, not unbounded new issuance, so manufacturing
vulnerabilities cannot become a minting strategy.

## Monetary draft

- Hard cap: **21,000,000 NIR**.
- Precision: **8 decimal places**.
- Intelligence-mining pool: **88%**.
- Builder and protocol treasury: **12%**, locked and intended to vest over ten
  years. This is a draft governance parameter, not a final allocation.
- A successful intelligence epoch starts at 50 NIR and its budget is cut in
  half after every 210,000 rewarded epochs. Empty blocks issue nothing and do
  not advance this counter. Rewarded blocks must be at least ten minutes apart,
  and the hard cap always wins.
- Holding NIR does not automatically grant protocol governance power.

The genesis allocation is assigned to explicit post-quantum NIR addresses; it
does not unlock into an exchange or a wallet from another network. The current demo uses a
temporary key. Before a public network, founder custody and the protocol
treasury must use disclosed, independently recoverable multisignature vaults.

Every transfer pays a consensus-enforced minimum fee of **0.00001000 NIR** to
the block proposer, and a sender may offer more for priority. Dynamic congestion
pricing, fee sponsorship for ordinary users, and whether part of a future base
fee is burned remain consensus decisions.

Wallets must present the fee both as NIR and as a percentage of the transfer.
The consensus fee itself is resource-based rather than value-based: moving a
large balance does not consume proportionally more network capacity.
The wallet quote marks fees above 0.1 percent for explicit confirmation; a one
percent fee is never silently accepted as a normal payment setting.

## Run the prototype

Requires Python 3.11+ and has no third-party dependencies.

```bash
python3 -m unittest discover -s tests -v

COMMITMENT=$(python3 -m nir.genesis commit \
  examples/genesis_suite.json --salt nir-genesis-demo)

python3 -m nir.genesis evaluate examples/genesis_suite.json \
  --salt nir-genesis-demo \
  --commitment "$COMMITMENT" \
  --baseline examples/baseline.json examples/baseline-2.json \
    examples/baseline-3.json \
  --candidate examples/candidate-1.json examples/candidate-2.json \
    examples/candidate-3.json \
  --contributor genesis-lab
```

The bundled suite is public and exists only to demonstrate the commit/reveal
flow. A real epoch commits to an unrevealed suite, requires the same three or
more independent verifiers to run both models, and reveals the suite only after
candidate runs are committed.

## Repository map

- `docs/protocol.md` — protocol and threat-model draft.
- `nir/model.py` — deterministic scoring and capped emission model.
- `nir/evaluator.py` — hidden-suite commitment and progress evaluation.
- `nir/memory.py` — world capability frontier, lineage, and novelty registry.
- `nir/genesis.py` — command-line commit/reveal demonstrator.
- `nir/simulation.py` — a small example epoch.
- `blockchain/` — post-quantum signed ledger and local chain demonstration.
- `blockchain/vault.mjs` — encrypted key vault and multisignature recovery manifest.
- `blockchain/wallet-files.mjs` — native encrypted wallet file and transaction signing.
- `docs/blockchain.md` — implemented consensus rules and current trust boundary.
- `docs/safety.md` — safety veto, threat domains, and certification limits.
- `docs/participation.md` — roles available to individuals and organizations.
- `docs/mining.md` — plain-language mining roles and intended user flow.
- `docs/privacy.md` — selective disclosure goals and regulatory constraints.
- `docs/value.md` — properties required for durable monetary value.
- `docs/governance.md` — where the ledger lives and how rules can safely evolve.
- `docs/wallet.md` — current native-wallet commands and production requirements.
- `SECURITY.md` — fixed findings, open blockers, and quantum-attacker review.
- `tests/test_model.py` — invariant tests.

## Run the blockchain core

Node.js 26+ is required for native ML-DSA-65 signatures.

```bash
npm run test:chain
npm run demo:chain
```

To try the current local mining flow:

```bash
npm run mine:demo
```

This command uses valueless local units. It does not mine tradeable NIR or join
a public network. The seven production roles and their intended one-screen user
flow are explained in `docs/mining.md`.

## Offline vault prototype

Run these commands only on a trusted offline machine. The destination directory
must not already exist. Passwords are read without echo and are never accepted
as command-line arguments or environment variables.

```bash
npm run vault:create -- /absolute/path/to/new-founder-vault
npm run vault:verify -- /absolute/path/to/new-founder-vault
```

Creation produces three separately encrypted guardian files and one public-data
recovery manifest for a two-of-three NIR address. Store the three files and
their distinct passwords in separate physical locations. Do not commit them to
Git, cloud-sync the complete set, or use this unaudited prototype for assets of
real value.

## Non-negotiable design constraints

NIR must remain useful to ordinary people as money, while its issuance serves
AI progress. Payments and mining are separate: paying for an AI answer moves
existing NIR; only verified new capability can mint NIR.
