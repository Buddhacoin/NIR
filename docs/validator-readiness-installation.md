# Readiness installed-release check

`verifyValidatorReadinessInstallation()` reuses the production node installer and monotonic-head
verifier before a readiness cohort may be treated as an operator deployment. It requires the
active installation target, durable head store, independently retained external anchor, signed
release, trusted release signer, and an exact operator-expected package hash. It checks the
complete installed generation and production evidence, then compares its network, genesis,
release manifest hash, stable version, and source revision with separately supplied expectations.
It rejects a different valid package, altered installed files, missing anchor, mixed network,
or damaged head copies.

`deriveValidatorReadinessInstallationExpectations()` first verifies the current, unexpired
readiness session and derives network, genesis, release manifest, version, and source revision
from that session. The package hash remains an independent operator policy pin: it must not
come from the package being inspected. `verifyValidatorReadinessInstallationForSession()`
combines both checks and also requires the release signer in the session to match the trusted
operator signer. This prevents a caller from supplying unrelated release-lineage expectations
for the same readiness cohort. The external anchor and trusted signer likewise need independent
operator-controlled origins.

An operator can inspect an installed generation without starting it:

```sh
npm run validator:verify-readiness-install -- session \
  SESSION.json SIGNED.json ANCHOR.json HEAD_STORE INSTALLATION \
  TRUSTED_SIGNER EXPECTED_PACKAGE_HASH
```

The `session` command verifies the bounded canonical session, signed release, external anchor,
active installation, and exact package hash. `inspect` accepts a separate canonical expectations
file instead of a session; it is useful for installation diagnostics but does not prove agreement
with a readiness cohort. Both commands are read-only and return a small verified summary or fail
with a nonzero exit code. The signer, package hash, and anchor must be independently retained
operator inputs rather than values copied from the downloaded package.

The inspection helpers do not themselves execute the installed entrypoint. The production-facing
three-process launcher now requires this verification and proves its own module path belongs to
the active generation before taking the listener and again before gateway COMMIT. Its separate
development entrypoint remains intentionally ungated for local tests and must not be used as a
public operator launch path. A successful end-to-end activation from an installed signed
generation, independent operators, and external review remain outstanding. Passing this check
alone does not authorize a public network.
