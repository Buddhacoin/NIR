# Opt-in local Qwen inference experiment

`nir.open_model_local_run` is a developer-only command for one pinned open
Qwen3-0.6B revision. The UI checks the runtime before offering a separate
download-confirmation dialog. Its loopback API requires the same origin and a
static consent header; that header is not proof of a human gesture. The Python
runner checks runtime again before any download. This UI path does not establish that the
model has run successfully on a user's machine. It does not
submit a claim, involve independent operators, establish a new capability,
participate in consensus, or credit NIR. Output fields explicitly say this.

On an Apple-silicon Mac with Python 3.13, install the optional packages into
a disposable virtual environment: `mlx==0.32.3`, `mlx-lm==0.32.0`,
`transformers==5.17.0`, and `huggingface_hub==1.5.0`. From the repository root,
run `python -m nir.open_model_local_run --prompt 'Reply with the single word NIR.'
--allow-1.5gb-download`. This downloads about 1.52 GB into a private temporary
directory, verifies the fixed Hub revision and its selected core bytes, runs
at most 32 generated tokens locally with remote model code disabled, and
deletes temporary package files on exit. Leave at least several GB of free
disk space. The required flag is deliberate consent for this download.

The app invokes `python3` from its own `PATH`. Run
`python3 -m nir.open_model_local_run --check-runtime` before launching it;
the check never downloads model bytes. If the check reports a missing package,
create and activate a disposable Python 3.13 virtual environment with the
pinned packages above, then restart `npm run mine:app` from that environment.
The app reports prerequisites before enabling its Qwen button. The catalog
selection does not choose the revision executed by this separate action.

The runtime is not sandboxed or independently attested. The package can be
modified by another same-user process between or during checks. A hostile
download may consume excess disk before the downloader rejects it. The Hub
revision and licence still require human review. Do not run on a shared or
untrusted host and do not use this output for reward eligibility. The next
security boundary is an immutable, isolated execution package with measured
runtime/dependencies and independent replay; post-execution hashing alone
cannot establish that boundary.
