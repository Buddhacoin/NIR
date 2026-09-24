# Independent Rust consensus core profile

`rust/nir-consensus-codec` is a deliberately narrow, independently compiled
implementation of consensus-critical NIR rules. It is a compatibility oracle,
not a second node and not a production client.

## Implemented profile

The crate currently implements six layers:

1. `nir-consensus-bytes-v1` value bytes, purpose-separated envelopes and
   SHA3-256 hashing;
2. the monetary state transition of an ordinary fee-paying NIR transfer;
3. the monetary state transition of a sponsored transfer whose distinct fee
   payer authorizes and pays the fee;
4. a zero-fee transfer paid from renewable Transfer Credits, either directly
   by the sender or through an owner-to-sender delegation;
5. the deterministic authorization and monetary transition of a multisignature
   account after individual signatures have been verified;
6. a canonical authorization envelope binding the exact unsigned transaction
   digest, algorithm, public keys and signature bytes passed by the full node.

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

Signature verification, network identifiers,
transaction schemas, account history, treasury vesting, block validation and
state-root calculation remain outside this profile.

For a sponsored transfer, the sender must independently hold the full amount
and the distinct fee payer must independently hold the full fee before any
credits are applied. Both current nonces must match and safely advance by one.
The sender pays only the amount, the fee payer pays only the fee, and the
proposer receives the fee. Recipient, proposer, sender and fee payer may share
addresses except that sender and fee payer must remain distinct. Alias cases do
not weaken the independent-funds checks. The transition computes all balance
and nonce results before mutation, conserves affected balances and leaves
burned supply unchanged.

Cryptographic sponsor authorization is checked by the full node before this
monetary transition.

The Transfer Credit transition derives the epoch from block height, derives
the allowance from locked stake, resets effective usage only when the epoch
changes, and increments owner usage by exactly one. Delegated use also requires
an existing owner-to-sender record and increments its current-epoch usage
without exceeding its limit. The NIR fee must be zero. Amount movement, sender
nonce, owner usage and optional delegation usage are calculated before any
mutation and commit atomically. A sender may transfer to itself, but a delegated
owner must be distinct from the sender.

Sponsored-credit uses the distinct fee payer as the credit owner, forbids a
delegation, and advances both sender and fee-payer nonces. It is handled by the
same atomic transition as direct and delegated credits, so recipient overflow,
replay or exhausted sponsor allowance cannot partially consume a credit or a
nonce. Signature, treasury and schema checks remain outside the helper.

The multisignature transition canonicalizes a bounded member set, derives the
account address from the exact descriptor, requires a threshold of distinct
verified members, and then applies the same bounded fee-paying monetary rules.
Unknown or duplicate signers, duplicate members, invalid thresholds, descriptor
address mismatch, replay, insufficient funds and balance overflow fail before
state mutation. The full node still verifies each individual signature over
the transaction before passing only verified signer identities into this
transition; the Rust profile does not implement signature verification.

The authorization profile independently reproduces the SHA3-256 digest of the
exact `TRANSFER` consensus envelope and rejects algorithm substitution,
transaction-field mutation, duplicate approvals and malformed key/signature
envelopes. Authorized ordinary and multisignature wrappers derive every signed
state-transition field directly from that digest-bound unsigned transaction;
only the block fee recipient remains external. This prevents a checked amount,
recipient, nonce or descriptor from being replaced before state mutation.

This is not independent ML-DSA-65 verification. The Rust API deliberately calls
the returned identities `preverified_signers`: the full node remains responsible
for verifying every signature against the canonical bytes. No new cryptographic
dependency was introduced without compatibility evidence and audit.

## Normative evidence

The Rust tests consume the same repository-owned language-neutral vectors as
the JavaScript implementation:

- `tests/vectors/consensus-codec-v1.json`;
- `tests/vectors/credit-transfer-state-v1.json`;
- `tests/vectors/multisig-transfer-state-v1.json`;
- `tests/vectors/transfer-authorization-v1.json`;
- `tests/vectors/transfer-state-v1.json`;
- `tests/vectors/sponsored-transfer-state-v1.json`.

The transfer suite contains successful role-alias cases and negative replay,
fee-floor, zero-value, insufficient-balance, nonce-overflow, decimal-encoding
and balance-overflow cases. Negative cases also assert that state is unchanged.
The sponsored suite additionally covers both nonces, replay of either nonce,
independent sender and fee-payer funding, all permitted participant aliases,
nonce exhaustion and overflow.
The credit suite covers direct, delegated and sponsored ownership, epoch
renewal, owner and delegation usage, quota exhaustion, delegation limits,
replay of either sponsored nonce, role aliases, balance overflow, conservation
and atomic rejection.
The multisignature suite covers descriptor binding, threshold success and
failure, duplicate and unknown signers, member bounds, replay, role aliases,
overflow, conservation and atomic rejection.
The authorization suite covers ordinary and multisignature envelopes plus
amount, recipient and nonce substitution, algorithm substitution, duplicate
approvals and malformed signature fields.
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
