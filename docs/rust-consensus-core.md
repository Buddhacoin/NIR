# Independent Rust consensus core profile

`rust/nir-consensus-codec` is a deliberately narrow, independently compiled
implementation of consensus-critical NIR rules. It is a compatibility oracle,
not a second node and not a production client.

## Implemented profile

The crate currently implements two layers:

1. `nir-consensus-bytes-v1` value bytes, purpose-separated envelopes and
   SHA3-256 hashing;
2. the monetary state transition of an ordinary, non-sponsored, fee-paying NIR
   transfer.

The transfer profile accepts canonical addresses, unsigned decimal amounts up
to 32 digits, a safe advancing nonce, balances and a fee recipient. A valid
transition:

- requires a positive amount and a fee of at least 1,000 atomic units;
- debits `amount + fee` from the sender;
- credits `amount` to the recipient and `fee` to the fee recipient;
- advances only the sender nonce by one;
- leaves burned supply unchanged;
- conserves the sum of all affected balances, including when two or all three
  roles use the same address;
- calculates every result before mutating state, so rejection is atomic;
- rejects replay, nonce exhaustion, malformed decimals, insufficient funds and
  bounded-balance overflow.

Signature, multisignature, sponsorship, Transfer Credits, network identifiers,
transaction schemas, account history, treasury vesting, block validation and
state-root calculation remain outside this profile.

## Normative evidence

The Rust tests consume the same repository-owned language-neutral vectors as
the JavaScript implementation:

- `tests/vectors/consensus-codec-v1.json`;
- `tests/vectors/transfer-state-v1.json`.

The transfer suite contains successful role-alias cases and negative replay,
fee-floor, zero-value, insufficient-balance, nonce-overflow, decimal-encoding
and balance-overflow cases. Negative cases also assert that state is unchanged.
Expected output is never copied into the transition: both implementations
execute the input and independently compare the resulting state or rejection
code.

Run the profile with the pinned toolchain:

```bash
cargo fmt --all --manifest-path rust/nir-consensus-codec/Cargo.toml -- --check
cargo clippy --locked --all-targets --manifest-path rust/nir-consensus-codec/Cargo.toml -- -D warnings
cargo test --locked --manifest-path rust/nir-consensus-codec/Cargo.toml
node --test tests/consensus-codec.test.mjs tests/transfer-state-vectors.test.mjs
```

The repository workflow runs the same Rust formatting, lint and test gates.
Changing either vector file, implementation or this profile changes the
protocol conformance inventory and must be reviewed rather than silently
accepted.

## Expansion rule

Add only one deterministic transition family at a time. Each expansion needs
language-neutral positive and negative vectors, atomic failure tests, exact
bounds, compatibility tests in both implementations, documentation of excluded
checks, and conformance-inventory coverage. The independent core must fail
closed when a rule is outside its implemented profile.
