# Pinned open-model download preflight

`nir.open_model_fetch.fetched_curated_model` is a library entry point for two
explicitly supported model revisions. It is not wired to the mining app or a
model runner. The browser catalog may discover newer revisions, but discovery
does not silently authorize downloading or reward eligibility. A new revision
requires a deliberate update to `SUPPORTED_REVISIONS`. These are supported
download pins only; separate security and licence review is required before
any model execution.

The bounded HTTPS downloader streams only the fixed core-file set into a
private temporary directory, with no Hub token and an explicit 40-character
revision. Before downloading, the code checks public, ungated Hub metadata
and the pinned file tree. It rejects missing core files, invalid paths,
malformed hashes, or a reported core set over 4 GiB. It rejects a response
that exceeds the pinned size *before writing excess bytes*, and accepts only
HTTPS redirects to Hub-controlled hosts. A single 20-minute deadline covers
all selected file downloads; each network read has a 15-second timeout. The
downloaded bytes are copied
through no-follow file descriptors into a separate temporary package;
Git blob OIDs or LFS raw SHA-256 and sizes are checked. The copied package is
then checked again against its manifest and pinned Hub metadata. All temporary
data is removed on exit or error. Tests inject downloads and do not fetch model
weights.

The streaming byte cap limits this downloader's writes, not all host-wide disk
activity. It trusts Hub file-size metadata and TLS, and does not authenticate
the publisher or review the licence. A malicious same-UID process can still
alter temporary files. Do not run it on an untrusted/shared host or represent
the package as an immutable installation.

Hub metadata and TLS are trust assumptions, not a publisher signature or a
licence review. `runtimeDigest` and `dependencyDigest` are caller declarations,
not measurements. A same-user process can alter the returned temporary path;
the files are not an immutable or sandboxed runtime mount. This library does
not execute a model, prove a new AI skill, provide independent operators or
consensus, or authorize any NIR reward.
