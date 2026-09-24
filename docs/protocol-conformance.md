# Protocol conformance manifest

The independently compiled Rust compatibility profile and its current scope are
documented in [`rust-consensus-core.md`](rust-consensus-core.md). Its normative
codec and monetary-transition vectors are part of the reviewed protocol
surface.

`protocol/conformance-manifest.json` is a deterministic, canonical inventory of
the repository's consensus and security-sensitive protocol surface. It is a
drift detector, not a replacement for review, tests, or a formal specification.
Generation and verification use only local files and perform no network access.

The versioned `nir-protocol-conformance-manifest-v1` records:

- every versioned `nir-…-vN` schema literal and all source locations;
- literal cryptographic domain separators and every unresolved dynamic-domain
  call site, so wrapper or dispatch changes cannot disappear silently;
- protocol, size, count, age, timeout, delay and threshold constant expressions;
- security-relevant `networkId` binding statements;
- protocol-version and activation feature-gate statements;
- SHA3-256 hashes of every source module contributing to that inventory;
- hashes of protocol/security documentation selected by deterministic content
  rules.

Repeated schema use in several modules is aggregated under one unique ID with
all locations. Duplicate or unordered manifest IDs, missing entries, unknown
top-level fields, tampering, stale source hashes, and stale documentation fail
closed. The complete payload is itself domain-separated and committed by
`manifestHash`.

## Review workflow

After an intentional protocol or security-document change:

```bash
npm run protocol:manifest-generate
git diff -- protocol/conformance-manifest.json
npm run protocol:manifest-verify
```

The generated diff is part of the security review. A changed schema, domain,
limit, network-binding statement, or feature gate must be explained by the same
change that regenerates the manifest. CI and release preparation should run the
verify command and must never regenerate automatically as a substitute for
review.

The generator also rejects plain references to unrelated external currencies
inside production protocol sources, formal models, and documentation. This is a
repository naming/content policy only; it does not claim interoperability or
perform semantic analysis.

## Boundaries

- Static extraction inventories literals, constant expressions, source
  locations, and unresolved dynamic call sites. It does not prove that every
  branch is reachable or that a parameter is economically sound.
- Dynamic domain dispatch remains visible as an expression plus a source hash;
  reviewers must inspect the corresponding mapping or wrapper call sites.
- Documentation selection is deterministic keyword matching. A new document
  without protocol/security terminology may not enter the manifest until its
  content or the selection rule changes.
- File hashes prove agreement with this repository snapshot, not correctness of
  the rules themselves.
