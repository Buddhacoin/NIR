# Contributing to NIR

NIR is preparing for a valueless public developer testnet. Contributions are
welcome, but a merged change is not evidence that the protocol is safe for real
value. Public claims must remain consistent with the implementation, tests,
[`SECURITY.md`](SECURITY.md), and the
[public testnet gates](docs/public-testnet-gates.md).

Unless explicitly marked otherwise before submission, contributions accepted
into this repository are provided under the [Apache License 2.0](LICENSE), as
described by section 5 of that license.

## Before opening a change

1. Search existing issues and pull requests for overlapping work.
2. Keep one pull request focused on one reviewable outcome.
3. For consensus, cryptography, issuance, fees, staking, slashing, recovery,
   validator rotation, or release trust, describe the invariant being changed
   and the failure mode being prevented.
4. Add deterministic tests for success, malformed input, replay, boundary, and
   restart behavior when those cases apply.
5. Run the complete local verification entry point:

   ```bash
   npm run verify
   ```

6. Changes that touch the independent Rust consensus implementation must also
   pass its locked checks:

   ```bash
   cargo fmt --all --manifest-path rust/nir-consensus-codec/Cargo.toml -- --check
   cargo clippy --locked --all-targets --manifest-path rust/nir-consensus-codec/Cargo.toml -- -D warnings
   cargo test --locked --manifest-path rust/nir-consensus-codec/Cargo.toml
   ```

7. If a tracked protocol surface changed, regenerate and verify the conformance
   inventory:

   ```bash
   npm run protocol:manifest-generate
   npm run protocol:manifest-verify
   ```

Do not regenerate the inventory merely to hide an unexplained difference.
Review the diff and state why every changed entry belongs in the change.

## Pull request evidence

Every pull request should include:

- the user-visible or protocol outcome;
- the threat or failure model, when security-relevant;
- files and consensus versions affected;
- tests run and their exact result;
- compatibility, migration, rollback, and recovery impact;
- documentation updated for changed commands or guarantees;
- remaining limitations and external checks still required;
- any employment, funding, operator, evaluator, or infrastructure conflict that
  could reasonably affect review independence.

Protocol changes must be fail-closed and replayable from genesis. A pull request
must not silently change canonical encoding, signature domains, state roots,
monetary rules, validator membership, trust anchors, or activation heights.
Version and migration behavior must be explicit and tested across the boundary.

## Secrets and test material

Never commit or paste:

- private keys, seed material, vault passwords, pairing tokens, or recovery
  shares;
- environment files, operator credentials, access tokens, TLS private keys, or
  private infrastructure addresses;
- real personal data, confidential model material, or production logs;
- a working exploit against a live third-party system.

Use freshly generated, valueless fixtures only. Assume every pull request,
workflow log, test artifact, review comment, and deleted Git revision may become
public and permanent. If secret material is committed, stop using it, rotate or
revoke it outside the repository, and report the exposure privately. Removing
it in a later commit is not sufficient.

## Security reports

Do not open a public issue for a vulnerability that could put operators, users,
or a future network at risk. Follow [`SECURITY.md`](SECURITY.md) and use a private
repository security advisory when that channel is available. Include only the
minimum reproducible evidence and no third-party secrets or personal data.

## Review and merge conditions

A change is ready for merge only when:

- required tests and the conformance inventory pass;
- generated files are reproducible and reviewed;
- new public inputs have explicit size, type, and resource bounds;
- signature, hash, network, epoch, nonce, and purpose bindings are preserved;
- persistence changes cover interrupted writes, restart, and corrupted input;
- documentation distinguishes implemented behavior from planned behavior;
- unresolved critical or high-risk findings are not presented as completed;
- the author is not the sole evidence source for an independence claim.

Maintainers may require adversarial tests, a migration rehearsal, an external
review, or a delayed activation before accepting a protocol-affecting change.
Passing automation is necessary but does not replace security review.

## Scope and conduct

Keep technical discussion specific, reproducible, and respectful. Review code
and evidence rather than a contributor's identity. Harassment, threats, doxxing,
fraudulent claims, undisclosed paid promotion, and attempts to obtain another
person's secrets are not accepted in project spaces.

The repository does not offer tokens, investment returns, exchange access, or a
guaranteed reward for contributions. Test balances and local mining output have
no monetary value.
