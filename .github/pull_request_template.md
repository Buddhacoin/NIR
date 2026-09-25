## Outcome

<!-- Required: what user-visible, operational, or protocol result does this PR produce? -->

## Scope and authority

- [ ] I identified whether this changes consensus, economics, cryptography/key custody, release trust, or wallet signing.
- [ ] I understand that merge access does not authorize a release, activate a protocol version, rewrite finalized chain state, or control operator keys.

Affected protocol version(s), activation boundary, and files:

<!-- Required. Write "none" only when genuinely not applicable. -->

## Invariants

Preserved or intentionally changed invariants:

<!-- Required: include supply/issuance, state-root, canonical encoding, signature domain,
network/genesis binding, replay/finality, validator/trust-set, and custody invariants that apply. -->

Failure mode prevented or accepted residual limitation:

<!-- Required. -->

## Tests and reproducible evidence

Exact commands run and results:

```text
# Required: paste commands and pass/fail counts. Do not write only "tests pass".
```

- [ ] Success and malformed-input paths are tested.
- [ ] Replay, boundary, restart/interrupted-write, and adversarial cases are tested where applicable.
- [ ] `npm run verify` passes, or the precise blocker and unaffected targeted tests are documented above.
- [ ] Protocol manifest changes were regenerated, reviewed, and verified, or this PR does not change a tracked protocol surface.

## Security review

Threat model, public-input bounds, secret handling, and abuse cases:

<!-- Required. State "not security relevant" only with a concrete reason. Never paste secrets. -->

- [ ] No private key, seed, password, recovery share, access token, production credential, or personal data is included.
- [ ] New signatures and hashes bind their purpose, network, identity, nonce/sequence, and version as applicable.
- [ ] New parsers and persistence paths fail closed and have explicit size/type/resource bounds.

## Compatibility, migration, rollback, and recovery

<!-- Required: describe old/new interoperability, stored-data migration, activation/cutover,
rollback behavior, interrupted migration recovery, and operator action. Write "none" with a reason. -->

## Documentation and disclosure

- [ ] User/operator documentation and commands are updated, or no documentation changes are required.
- [ ] Implemented behavior is clearly separated from planned work and external launch gates.
- [ ] Relevant employment, funding, infrastructure, validator, evaluator, or reviewer-independence conflicts are disclosed below.

Disclosures and remaining external checks:

<!-- Required. -->

## Reviewer checklist

- [ ] Required Code Owners reviewed the sensitive paths.
- [ ] The diff does not silently change monetary rules, trust anchors, canonical encoding, signature domains, activation heights, or validator membership.
- [ ] Generated artifacts and manifest differences are reproducible and explained.
- [ ] Critical/high findings are resolved or explicitly block merge/release.
