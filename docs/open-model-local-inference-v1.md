# Opt-in local Qwen inference experiment

`nir.open_model_local_run` is a developer-only command for one pinned open
Qwen3-0.6B revision. The UI checks the runtime before offering a separate
download-confirmation dialog. Its loopback API requires the same origin and a
static consent header; that header is not proof of a human gesture. The Python
runner checks runtime again before any download. The app starts a local job and
polls a separate result route, so a multi-minute download does not hold one
HTTP response open. One successful local run does not establish that the model
will run on another user's machine. It does not
submit a claim, involve independent operators, establish a new capability,
participate in consensus, or credit NIR. Output fields explicitly say this.

On an Apple-silicon Mac with Python 3.13, install the optional packages into
a disposable virtual environment: `mlx==0.32.3`, `mlx-lm==0.32.0`, and
`transformers==5.17.0`. Their transitive dependencies are not separately pinned
or attested by this experiment. From the repository root,
run `python -m nir.open_model_local_run --prompt 'Reply with the single word NIR.'
--allow-1.5gb-download`. This downloads about 1.52 GB into a private temporary
directory, verifies the fixed Hub revision and its selected core bytes, runs
at most 32 generated tokens locally with remote model code disabled, and
deletes temporary package files on exit. Before downloading, it checks that
free space exceeds twice the selected file sizes plus 1 GiB of headroom, since
the incoming and verified copies coexist. An interprocess advisory lock stops
two honest copies of this runner from downloading simultaneously. These checks
are not a host-wide disk reservation or protection from another same-user
process. The required flag is deliberate consent for this download.

The app invokes `python3` from its own `PATH`. Run
`python3 -m nir.open_model_local_run --check-runtime` before launching it;
the check never downloads model bytes. If the check reports a missing package,
create and activate a disposable Python 3.13 virtual environment with the
pinned packages above, then restart `npm run mine:app` from that environment.
The app reports prerequisites before enabling its Qwen button. The catalog
selection does not choose the revision executed by this separate action.

The runtime is not sandboxed or independently attested. The package can be
modified by another same-user process between or during checks. A hostile
download or another process may still exhaust disk despite the preflight. The Hub
revision and licence still require human review. Do not run on a shared or
untrusted host and do not use this output for reward eligibility. The next
security boundary is an immutable, isolated execution package with measured
runtime/dependencies and independent replay; post-execution hashing alone
cannot establish that boundary.
