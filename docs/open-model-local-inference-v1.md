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

The source-mode app invokes `python3` from its own `PATH`. Run
`python3 -m nir.open_model_local_run --check-runtime` before launching it;
the check never downloads model bytes. If the check reports a missing package,
create and activate a disposable Python 3.13 virtual environment with the
pinned packages above, then restart `npm run mine:app` from that environment.
The app reports prerequisites before enabling its Qwen button. The catalog
selection does not choose the revision executed by this separate action.

The macOS local app records a bounded SHA-256 identity for the selected Node.js
and Python executables, their exact symlink chains, the virtual environment and
the external Python base-prefix tree. A signed native verifier repeats these
checks before external Node.js starts. It rejects changed targets, bytes,
`pyvenv.cfg`, added or changed `site-packages`, broken-link state, or an
over-limit tree. The builder also reads each runtime's Mach-O load commands with
the system `otool`, recursively resolves its non-system startup libraries, and
records each library's logical path, canonical path, size, and digest. The
manifest also records every absent earlier `@rpath` candidate considered before
the selected library; the verifier rejects a later file appearing at any such
path. The native verifier repeats those file, redirect, and absence checks
before launch. At build
time it resolves every ancestor directory of each runtime and records that
canonical launch path while retaining the final `bin/python` symlink needed for
virtual-environment discovery. Changing a convenience alias such as
`venv-current` therefore cannot redirect the signed app from the selected
environment to another one. The launcher also removes Node/Python path-injection variables
and disables the user site and bytecode writes. This is a fail-closed **local
consistency guard**, not immutable runtime attestation: verification and exec
are separate operations. System libraries under `/usr/lib` and `/System/Library`
remain trusted OS inputs, and libraries selected later by application-controlled
`dlopen` or plugin paths are not proven by the startup Mach-O closure. A
privileged or racing same-user process can still change external files after
verification. The app is ad-hoc signed, so this
does not prove publisher identity and an attacker able to rewrite and re-sign
the app can replace the manifest and verifier. A hostile parent can also inject
code through loader controls such as `DYLD_INSERT_LIBRARIES` before the first
line of the verifier runs; preventing that requires hardened, identified release
signing rather than an ad-hoc local signature. Rebuild after any intentional
runtime update; do not use this guard as reward evidence or secure distribution.

After a Qwen run, the app can download a small JSON local replay record. It
binds the fixed prompt and observed answer to the package identity and declared
generation settings with a domain-separated SHA-256 digest. A second process
can check the record and repeat the model run with
`python3 -m nir.open_model_local_run --replay-record /path/to/record.json
--allow-1.5gb-download`. The same runtime and model download are required again;
the command fails if the record is malformed, its hash differs, the package
identity differs, or the answer differs. The file is bounded and read without
following a final symlink. The UI and local HTTP service check the record hash
before offering the download. This is a local replay facility, **not** a signed
claim, proof of the first execution, independent operator verdict, safety or
energy attestation, consensus input, or NIR reward. Anyone can construct a
matching hash for fabricated fields; only an independently run, protocol-bound
evaluation can advance beyond this experiment.

The runtime is not sandboxed or independently attested. The package can be
modified by another same-user process between or during checks. A hostile
download or another process may still exhaust disk despite the preflight. The Hub
revision and licence still require human review. Do not run on a shared or
untrusted host and do not use this output for reward eligibility. The next
security boundary is an immutable, isolated execution package with measured
runtime/dependencies and independent replay; post-execution hashing alone
cannot establish that boundary.
