# Validator readiness session package

The production readiness boundary uses a short-lived, portable public package before any isolated
signer is started. This package contains no password, vault path, private key, TLS private key, or
local filesystem identity.

The creator generates `sessionId` internally from 32 bytes of operating-system CSPRNG output.
Callers cannot supply or reuse that boot/session nonce.

`nir-validator-readiness-session-v1` binds one verified admission public plan and its commitment,
one release provenance derived from a signed release trusted locally by the launcher, one
checkpoint trust package and its existing package hash, the exact live-readiness context, and the
canonical active validator set. Verification independently checks the checkpoint witness policy
and finality proof. The computed validator-set ID, the finality checkpoint validator-set ID, and
the readiness-context validator-set ID must all agree. The checkpoint height, tip/block hash, and
state root must also agree exactly.

The readiness context must name the same network, chain-identity genesis, candidate consensus
identity and operator, transport identity, HTTPS endpoint, and TLS certificate fingerprint as the
public join plan. Its admission ID and account nonce are retained in the committed context. Block
expiry (`expiresAtHeight`) is checked separately from the session's wall-clock expiry (`expiresAt`):
the context remains limited to sixteen blocks, while a process session may live for at most sixty
seconds. Passing either limit requires a newly verified package; changing the local clock cannot
revive an old checkpoint sequence or block-height context.

The launcher creates the package only from `verifySignedRelease` output and an explicitly trusted
release signer address. The package stores release provenance, not the full release or its
signature. Consequently the launcher must obtain that address from local policy rather than from
the candidate or the package itself.

The session and role hashes are integrity commitments, not signatures and not an origin proof.
Signer processes may trust a role package only when it arrives on the launcher-created inherited
descriptor and is pinned before accepting gateway IPC. Receiving the same JSON from the gateway,
a reconnectable socket, or a persisted untrusted file is insufficient; such a transport would also
need a locally pinned expected provenance or the complete signed-release verification input.

Three derived envelopes have distinct formats and hash domains:

- `nir-validator-readiness-gateway-package-v1`
- `nir-validator-readiness-transport-package-v1`
- `nir-validator-readiness-consensus-package-v1`

A consumer verifies both the embedded session and its expected role. A package issued for one role
cannot be relabeled for another role. These envelopes define the data boundary only; they do not
implement IPC, process launching, vault access, or a generic signing API.
