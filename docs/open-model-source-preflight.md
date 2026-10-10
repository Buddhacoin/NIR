# Experimental source comparison for open models

The catalog's observed commit SHA is a choice of revision, not proof that a
local package came from the model publisher. A local file inventory alone can
also bind an arbitrary repository name and arbitrary 40-character revision.

The source preflight compares a locally measured package with metadata fetched
over HTTPS from a fixed Hugging Face model repository at the **exact selected
commit**. The local package may be an explicitly selected subset of the source
tree; unselected repository files are not downloaded. It rejects redirects,
incomplete or malformed metadata, private or gated models, and selected file
identities that differ from the revision. For
Git LFS files it checks the reported raw SHA-256 and size; for ordinary Git
files it checks the Git blob object ID against the local bytes. The separate
local package preflight still checks raw SHA-256 for every file.

This establishes only that the observed local bytes match metadata served by
Hugging Face under HTTPS trust at the pinned revision. It does not establish
publisher authorship, validate a model licence or card, authenticate a signed
commit, create an immutable execution snapshot, verify actual runtime binaries,
isolate inference, measure energy, or permit a reward. No model is downloaded
or executed by this preflight. It uses a system CA store or, on a Python
installation without one, an installed `certifi` CA bundle; TLS verification is
never disabled. If metadata cannot be fully checked, it fails closed; an old
catalog entry is not silently rebound to current HEAD.
