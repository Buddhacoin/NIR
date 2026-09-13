# NIR Protocol

NIR is an experimental monetary protocol in which new currency is issued for
**verified progress in machine intelligence**, not for raw computation alone.

> Bitcoin proves that energy was spent. NIR aims to prove that intelligence was created.

This repository is the first executable protocol sketch. It is deliberately
not a tradable token, investment product, wallet, or mainnet.

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

## Monetary draft

- Hard cap: **21,000,000 NIR**.
- Precision: **8 decimal places**.
- Intelligence-mining pool: **88%**.
- Builder and protocol treasury: **12%**, locked and intended to vest over ten
  years. This is a draft governance parameter, not a final allocation.
- Epoch reward starts at 50 NIR and halves every 210,000 epochs; the hard cap
  always wins.
- Holding NIR does not automatically grant protocol governance power.

## Run the prototype

Requires Python 3.11+ and has no third-party dependencies.

```bash
python3 -m unittest discover -s tests -v

COMMITMENT=$(python3 -m nir.genesis commit \
  examples/genesis_suite.json --salt nir-genesis-demo)

python3 -m nir.genesis evaluate examples/genesis_suite.json \
  --salt nir-genesis-demo \
  --commitment "$COMMITMENT" \
  --baseline examples/baseline.json \
  --candidate examples/candidate-1.json examples/candidate-2.json \
    examples/candidate-3.json \
  --contributor genesis-lab
```

The bundled suite is public and exists only to demonstrate the commit/reveal
flow. A real epoch commits to an unrevealed suite, requires three distinct
verifiers, and reveals the suite after candidate runs are committed.

## Repository map

- `docs/protocol.md` — protocol and threat-model draft.
- `nir/model.py` — deterministic scoring and capped emission model.
- `nir/evaluator.py` — hidden-suite commitment and progress evaluation.
- `nir/genesis.py` — command-line commit/reveal demonstrator.
- `nir/simulation.py` — a small example epoch.
- `tests/test_model.py` — invariant tests.

## Non-negotiable design constraints

NIR must remain useful to ordinary people as money, while its issuance serves
AI progress. Payments and mining are separate: paying for an AI answer moves
existing NIR; only verified new capability can mint NIR.
