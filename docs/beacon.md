# Independent beacon operations

One independently operated service exposes two cryptographically separated
purposes. `progress` is mandatory for assigning an unpredictable AI evaluation
challenge after its candidate commitment is final. `fallback` is used only when
a bonded validator commits a safety-randomness contribution and then withholds
its reveal.

Each authority produces its own unpredictable 32-byte share and signs it with
a separate ML-DSA-65 wallet. Progress and fallback signatures use different
domains, so a share cannot cross purposes. The chain accepts an aggregate only when more
than two thirds of the genesis beacon registry signed distinct shares for the
same network, candidate and round. It deterministically hashes all supplied
shares, so an aggregator cannot alter a share. A threshold aggregate can still
choose among valid signer subsets; removing that residual selection bias needs
a formally reviewed threshold-randomness construction before mainnet.

## Run one authority

Create a dedicated wallet vault on an offline-controlled machine, then run:

```bash
npm run beacon:serve -- /absolute/path/beacon-wallet.nir nir-testnet 8791 127.0.0.1
```

The password is read interactively and never accepted through command-line
arguments or environment variables. The service exposes:

- `GET /health` — public address, algorithm and network;
- `POST /v1/share` — JSON containing `candidateId`, integer `round`, and
  `purpose` equal to `progress` or `fallback`.

Omitting `purpose` selects `fallback` for backward compatibility. A service
persists an append-only decision file beside its vault and returns
the same signed share when the same purpose, candidate and round are requested again,
including after restart. Back up this `.beacon-state.json` file: deleting or
rolling it back permits equivocation and randomness grinding. Run the service
behind mutually authenticated TLS, request limits and monitoring; never expose
the development HTTP listener directly to the Internet.

After collecting at least three shares in separate files, an untrusted
aggregator can construct the claim:

```bash
npm run beacon:aggregate -- nir-testnet CANDIDATE_HASH ROUND a.json b.json c.json
npm run progress-beacon:aggregate -- nir-testnet CANDIDATE_HASH ROUND a.json b.json c.json
```

The aggregate itself is not trusted: every full node verifies every authority
signature, recomputes the aggregate and enforces the on-chain quorum.

## Independence requirements

Production should begin with at least four authorities. They must be operated
by different legal or community entities, on different hosting providers and
administrative accounts, with separate vault backups and incident contacts.
No authority may also be a finality validator or intelligence evaluator.

Code cannot create organizational independence. Before mainnet, operators must
publish their public keys and deployment attestations, perform a coordinated
failure exercise, and commission an external audit. The repository provides
the service and verification path; it does not claim that those external
operators or the audit already exist.
