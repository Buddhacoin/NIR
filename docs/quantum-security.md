# Quantum security boundary

NIR is designed to avoid depending on classical public-key signatures for
ownership or consensus. It is not accurate to call the whole system
"quantum-proof." This document states which layers resist currently known
quantum attacks and which layers still require migration or independent review.

## Layer-by-layer result

| Layer | Current construction | Quantum-attacker result |
| --- | --- | --- |
| Accounts, transfers, votes, receipts, P2P authentication | ML-DSA-65, with protocol-purpose domain separation | Intended to resist large-scale quantum computers under NIST FIPS 204 assumptions |
| Addresses, blocks, state roots, commitments | Full SHA3-256 outputs | Grover search reduces the ideal preimage margin to roughly 128 bits; NIR does not truncate addresses |
| Vault encryption | AES-256-GCM with scrypt-derived keys | The symmetric primitive retains a substantial margin, but a weak human password remains guessable |
| Network transport | TLS 1.3 with conventional certificates and consensus-pinned fingerprints | Not post-quantum confidential; recorded traffic may be decrypted later and a certificate key may eventually be recovered |
| Runtime and builds | Node.js/OpenSSL implementation | Mathematics cannot prevent bugs, side channels, dependency compromise, or malicious releases |

## Fixed in the current review

Replica height and tip used to be read through an unsigned public health route.
That made TLS certificate security part of the consensus synchronization trust
boundary. Coordinator health and validator P2P health now use separate,
replay-resistant ML-DSA request and response signatures. A forged TLS endpoint
cannot claim a different chain height or tip without also forging the registered
application-layer key.

Encrypted vaults now validate canonical Base64 and exact nonce, salt, and GCM
tag sizes before invoking cryptography. They bound ciphertext and password
inputs, verify that address, public key, and private key belong together before
encryption, and clear the derived AES key buffer after encryption or decryption.
Negative tests cover truncated tags, malformed encodings, oversized ciphertext,
password bounds, and mismatched keys.

## What a quantum attacker can still do

1. Record TLS traffic and wait for a future ability to decrypt it. NIR must not
   transport vault secrets, hidden model data, or long-lived confidential data
   over the current channel.
2. Attack weak vault passwords offline after stealing a vault file. Users need
   high-entropy generated passphrases until reviewed hardware-key support exists.
3. Exploit implementation errors, timing leakage, dependency substitution, or a
   compromised release pipeline. These require audits, reproducible builds,
   multiple implementations, and hardware isolation rather than a new algorithm.
4. Exploit a future cryptanalytic break in ML-DSA. Protocol cryptography must be
   versioned so a finalized governance transition can move funds and validator
   identities before the old suite is disabled.
5. Attack availability. Post-quantum signatures do not stop traffic floods,
   partitions, validator collusion, endpoint censorship, or economic capture.

## Production requirements

- replace conventional-only TLS key establishment with an RFC 10024 hybrid
  ECDHE-ML-KEM group in a runtime that exposes and verifies the negotiation;
- add official FIPS 204 known-answer vectors and a second independent verifier;
- add algorithm-version fields and a rehearsed on-chain cryptographic migration;
- evaluate ML-DSA plus an independently structured backup signature such as
  SLH-DSA instead of depending forever on one assumption family;
- isolate wallet and validator keys in reviewed hardware, lock secret memory,
  and produce reproducible signed releases;
- obtain independent cryptographic, implementation, consensus, and economic
  audits before any network carries real value.

Primary references: [NIST FIPS 204](https://csrc.nist.gov/pubs/fips/204/final),
[NIST post-quantum migration project](https://csrc.nist.gov/projects/post-quantum-cryptography),
[NIST migration FAQ](https://pages.nist.gov/nccoe-migration-post-quantum-cryptography/),
and [IETF RFC 10024](https://datatracker.ietf.org/doc/html/rfc10024).
