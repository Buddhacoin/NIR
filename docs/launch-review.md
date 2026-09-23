# Public developer-testnet launch review

This is the final cryptographic review package for a valueless public developer
testnet. It does not launch a network, grant custody, represent value, or prove
that signers are independent. It records the exact hashes of the retained
artifact and verifier result for every gate 0–13, one network ID, a bounded
observation window, and a predeclared review group with at least four operators
and two security reviewers.

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
