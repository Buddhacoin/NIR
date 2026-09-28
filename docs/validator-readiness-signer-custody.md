# Validator readiness signer custody

The signer child opens its encrypted role vault into a deliberately narrow in-process capability.
`createValidatorReadinessSignerCustody` accepts the validated encrypted vault, its expected public
vault commitment from the already verified role bootstrap, a caller-owned password `Buffer`, and
exactly one role (`transport` or `consensus`). It always clears the password Buffer before returning
or throwing. A different valid encryption of the same private key is rejected because its full-vault
hash does not equal the bootstrap commitment.

Vault plaintext never becomes a JavaScript string or a wallet object. AES-GCM plaintext is retained in
Buffers, wrapped as a PKCS#8 PEM Buffer, and imported directly as an ML-DSA `KeyObject`. The factory
derives the public SPKI and requires it to match the vault address, public key, algorithm, and full-vault
commitment. All controlled password, KDF, ciphertext, plaintext, PEM, and derived-key byte buffers are
cleared on every exit. The runtime-held `KeyObject` remains private inside the closure and is never
exported.

The returned frozen, null-prototype object serializes to only `address`, `algorithm`, and `publicKey`.
It has no wallet, raw key, generic `sign`, export, or caller-supplied domain API. Its non-enumerable
methods are limited to:

- the role-specific readiness operation (`signReadinessTransportInput` or
  `signReadinessConsensusInput`); and
- `signValidatorReadinessReadyInput`, fixed to the same role's process-READY domain.

The capability-specific READY constructor requires this exact frozen, null-prototype own-property
surface, including the correct role operation method and no symbol properties. A look-alike object
with an additional export, key object, generic signing method, or hidden symbol is rejected.

Both methods check cancellation immediately before and after the synchronous key operation. The
process protocol's capability-specific READY constructor verifies the returned signature before it
creates a READY proof. Existing wallet-based test and ceremony callers remain supported by the
original constructor; production signer children should use the capability-specific constructor.

This increment does not spawn a process, read a vault path, accept passwords from the environment, or
open a network listener. The trusted launcher/runtime is responsible for passing the already bounded
vault object and one-time password bytes to the future child entrypoint.
