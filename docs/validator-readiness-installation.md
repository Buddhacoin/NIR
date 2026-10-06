# Readiness installed-release check

`verifyValidatorReadinessInstallation()` reuses the production node installer and monotonic-head
verifier before a readiness cohort may be treated as an operator deployment. It requires the
active installation target, durable head store, independently retained external anchor, signed
release, trusted release signer, and an exact operator-expected package hash. It checks the
complete installed generation and production evidence, then compares its network, genesis,
release manifest hash, stable version, and source revision with separately supplied expectations.
It rejects a different valid package, altered installed files, missing anchor, mixed network,
or damaged head copies.

The helper does not itself execute the installed entrypoint or prove that the code calling it was
loaded from that generation. The current three-process readiness launcher still does not require
this helper, and there is no operator CLI. The next integration must make installation verification
and installed-entrypoint identity mandatory before gateway activation, without accepting a caller-
fabricated "verified" flag. Passing this check alone does not establish independent operators or
authorize a public network.
