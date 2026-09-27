# Validator readiness process bootstrap

This layer defines the portable, canonical packages a future trusted launcher must deliver to the
readiness gateway and its two isolated signers. It does not launch a process, read a password,
decrypt or open a vault, create a TLS server, or claim operating-system isolation.

## Launch package set

`createValidatorReadinessProcessBootstrapSet` creates one fresh 256-bit `launcherNonce` and three
role-specific packages. Consensus and transport packages contain their own verified role package,
the session, role-package and release-provenance hashes, the initial trusted height, and a public
commitment to the exact encrypted vault. The gateway package contains its gateway role package,
TLS certificate fingerprint, bounded service limits, and the hashes of both signer packages. All
three carry the same launch nonce, session, release provenance, and initial height. Distinct hash
domains prevent changing a package's role.

The vault commitment contains only the ML-DSA public identity and a tagged hash of the complete,
strictly validated encrypted-vault object. The hash therefore covers its label, KDF parameters,
salt, IV, authentication tag, and ciphertext, although none of those private-at-rest fields are
copied into a bootstrap package. Validation is structural and does not decrypt or authenticate the
ciphertext; the signer process must do that later using trusted secret input.

Verification is fail-closed and exact-schema. Every exported verifier requires launcher-local
copies of the expected launch nonce, release-provenance hash, and session hash; accepting values
only from the package being checked would permit a wholly substituted but internally consistent
launch. A signer verifier additionally requires both `expectedRole` and the encrypted vault
supplied through a separate trusted launcher decision. A gateway verifier requires both signer
bootstrap packages. Neither verifier accepts a file path, environment value, or self-declared
release authority.

## Height updates

Consensus and transport have separate height-update formats and hash domains. Update 1 points to
the process bootstrap; every later update points to the exact previous update hash. Sequence must
increase by exactly one, height may not decrease, and every height must remain at or above the
session checkpoint and strictly below `expiresAtHeight`. Wall-clock expiration remains a separate
role-package check. The consumer must retain the last verified update for the life of the process;
there is deliberately no cache eviction or rollback rule in this portable schema layer.

These messages are intended for a trusted, inherited launcher channel. They do not make a mutable
network message into a trusted height source.

## Signer READY proof

After independently validating its bootstrap and decrypting its pinned vault, a signer creates a
role-specific READY proof with a fresh 256-bit process nonce. The role key signs a fixed-domain
object binding the launcher nonce, bootstrap hash, role/session/package/release hashes, vault hash,
public address, and operating-system PID. A consensus READY proof cannot be replayed as transport,
across launches, against another vault, or against another session. READY verification also
requires the launcher-local child PID; the PID declared by the signer is never trusted by itself.

There is no gateway READY signature in this layer because the gateway owns no signing key. The
future launcher must instead treat gateway liveness as an inherited-channel lifecycle fact after it
has verified the gateway bootstrap.

## Production boundary

This is protocol preparation for the next launcher increment, not production process isolation.
Production still requires real child processes, inherited bootstrap/session/IPC descriptors,
one-time secret input, role-specific vault opening, fatal cleanup, and deployment hardening. A
separate OS identity, disabled core dumps, debugger/ptrace restrictions, least-privilege filesystem
access, and service supervision are deployment requirements and cannot be guaranteed by portable
Node.js package validation.
