# Pinned open-model download preflight

`nir.open_model_fetch.fetched_curated_model` is a library entry point for two
explicitly supported model revisions. It is not wired to the mining app or a
model runner. The browser catalog may discover newer revisions, but discovery
does not silently authorize downloading or reward eligibility. A new revision
requires a deliberate update to `SUPPORTED_REVISIONS`. These are supported
download pins only; separate security and licence review is required before
any model execution.

The optional `huggingface_hub` dependency downloads only the fixed core-file
set into a private temporary directory, with `token=False` and an explicit
40-character revision. Before downloading, the code checks public, ungated
Hub metadata and the pinned file tree. It rejects missing core files, invalid
paths, malformed hashes, or a reported core set over 4 GiB. The downloaded bytes are
copied through no-follow file descriptors into a separate temporary package;
Git blob OIDs or LFS raw SHA-256 and sizes are checked. The copied package is
then checked again against its manifest and pinned Hub metadata. All temporary
data is removed on exit or error. Tests inject downloads and do not fetch model
weights.

The 4 GiB check is on Hub-reported metadata; `hf_hub_download` may consume
temporary disk space before this wrapper can reject an oversized or hostile
response. Until the download transport enforces streaming byte limits, do not
run this on an untrusted/shared host or represent it as disk-exhaustion-safe.

Hub metadata and TLS are trust assumptions, not a publisher signature or a
licence review. `runtimeDigest` and `dependencyDigest` are caller declarations,
not measurements. A same-user process can alter the returned temporary path;
the files are not an immutable or sandboxed runtime mount. This library does
not execute a model, prove a new AI skill, provide independent operators or
consensus, or authorize any NIR reward.
