# Experimental open-model package integrity

The read-only model catalog is not an executable model or mining workflow. A
Hugging Face repository commit identifies source metadata, not verified model
weights. Before a selected open model may be evaluated, its exact local files
must be checked against a reviewed manifest.

`nir.open_model_package.verify_package` is an experimental, local-only integrity
preflight. It streams every allowlisted file, checks its size and SHA-256, and
rejects missing, unexpected, linked, or non-canonical paths observed during
its two inventory passes. Its returned package identity binds the *claimed*
repository revision, file inventory, and *declared* runtime/dependency digests.
It does **not** prove that the files came from that repository revision (including
LFS objects), or attest the actual runtime. The module does not download files,
verify publisher signatures or licences, sandbox inference, authenticate an
operator, measure energy, or issue a reward.

The existing application adapter v1 commits only its entrypoint and remains
reward-ineligible. Do not pass a package identity to the v1 adapter and assume
that its process used the measured bytes: files can change between the two scans
or after preflight returns. A future executor must bind and isolate exact file snapshots,
inputs, dependencies, and runtime before any independently checked evidence can
be considered for consensus.
