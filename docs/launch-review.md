# Public developer-testnet launch review

This is the final cryptographic review package for a valueless public developer
testnet. It does not launch a network, grant custody, represent value, or prove
that signers are independent. It records the exact hashes of the retained
artifact and verifier result for every gate 0–13, one network ID, a bounded
observation window, and a predeclared review group with at least four operators
and two security reviewers.

## Input contract

`launch-review-input.json` is canonical JSON with exactly these fields:

- `format`: `nir-public-testnet-launch-review-v1`;
- `networkId`, `observedAt`, `expiresAt` — one network and a positive review
  window of no more than 24 hours, expressed as Unix milliseconds;
- `evidence`: exactly 14 entries, ordered by `gate` from `0` through `13`.
  Every entry is exactly `{ "artifactHash", "gate", "resultHash" }`; both
  hashes are 64 lowercase hexadecimal characters. `artifactHash` is the hash
  of the retained gate artifact and `resultHash` is the hash of that gate's
  verifier output;
- `reviewers`: an array ordered by `reviewerId`, with at least four entries of
  role `operator` and two of role `security-reviewer`. Every entry is exactly
  `{ "address", "algorithm", "publicKey", "reviewerId", "role" }`.
  Each address and public key must be unique.

The program checks shape, ordering, hash syntax, key/address consistency, role
counts and every signature. It cannot establish that distinct keys belong to
distinct people or organizations; that remains an external launch-review duty.

Create a canonical unsigned package from a reviewed JSON input, then each
reviewer signs the current package in turn. Reviewers should compare the input
hashes with the independently retained artifacts before signing.

```sh
npm run launch-review -- create launch-review-input.json > launch-review.json
NIR_LAUNCH_REVIEW_PASSWORD_FD=3 npm run launch-review -- sign \
  launch-review.json reviewer-vault.json operator-0 3< /secure/password-fd \
  > launch-review-operator-0.json
```

The vault password is never a command argument or environment value: the
environment holds only an inherited descriptor number. Vaults must be
single-link owner-only `0600` files; all review JSON must be canonical,
single-link, and not writable by group or others.

After every configured signer has approved the exact same package, verify it
offline at the agreed time:

```sh
npm run launch-review -- verify launch-review-final.json nir-public-dev NOW_MS
```

`LAUNCH-REVIEW-CRYPTOGRAPHIC-PASS` proves only hash binding, signatures, role
counts, expiry and complete approval coverage. It is not an independence or
production claim. Reviewers must still establish external facts such as
separate control, host diversity and unresolved findings before any public
developer-testnet decision.
