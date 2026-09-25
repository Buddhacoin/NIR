# Validator deployment wizard (Mac/Linux)

`validator:deploy` turns ceremony-approved **public evidence** into a deterministic
operator checklist. It is not a key generator and never accepts, reads, writes,
or prints a password or private key. The output is a public plan, not proof that
the host is independent or already reachable.

Requires macOS or Linux, Node.js 26+, the exact compiled genesis, ceremony plan
and approvals, external ceremony anchor, signed release, public TLS certificate,
and the already-created encrypted validator and transport vault paths. Prepare a
canonical input using format `nir-validator-deployment-input-v1`; its
`artifacts` and `paths` entries must be distinct absolute paths. `expected` must
state the network ID, compiled genesis hash, release manifest hash, validator
HTTPS origin, and TLS SHA-256 fingerprint. Set `certificateMode` to `lifecycle`.
Set `paths.planOutput` to the exact new output path. The operator does not enter
bootstrap peers: the wizard derives the complete ordered URL list from the
verified ceremony/genesis peer registry so positional transport identities
cannot be reordered or omitted.

Create a new plan (the output path must not exist):

```sh
npm run validator:deploy -- plan deployment-input.json deployment-plan.json
```

The wizard verifies the complete ceremony and signed release, recompiles and
compares genesis, verifies the external anchor, locates the exact validator and
peer entry, and checks the supplied certificate against the ceremony pin. It
then emits ordered argv arrays for public-identity checks, ceremony install,
certificate bootstrap, reverification, startup, and health. It does not execute
them. Passwords remain interactive or arrive through the protected descriptors
documented in [validator ceremony onboarding](validator-ceremony-onboarding.md).
Because peers are derived and the output path is an input, the emitted argv
arrays contain no shell placeholders.

After startup, perform a live TLS-pinned health check:

```sh
npm run validator:deploy -- health deployment-plan.json
```

This command connects with TLS 1.3, pins the ceremony certificate fingerprint,
and requires the returned validator address, network, lifecycle mode, and ready
status to match the plan. Plan creation alone does **not** claim live reachability.

## Production gaps

- Bonding or selection does not automatically place a validator into the active
  finality set; a separately authorized validator rotation is still required.
- Validator exit and bond withdrawal are not implemented yet.
- Certificate bootstrap requires quorum responses from already trusted,
  independent peers; listing them in a plan does not prove their independence.
- Host hardening, external monitoring, supervisor credential pipes, independent
  failure domains, and external audit remain deployment responsibilities.
