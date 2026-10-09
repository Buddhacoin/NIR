# Wallet recovery v1: experimental key derivation

This is an internal design and test implementation for a **valueless** NIR
wallet. It is not enabled in the Mac app and has not been independently audited.
Do not use it to secure assets of real value or import another wallet's phrase.

The intended user flow is: install the official app, create a new wallet, write
down its 24-word English recovery phrase, and set a local password. On a new
device the user enters the phrase, chooses a **new** local password, and the
same NIR addresses are regenerated. No user-selected vault file or recovery
code is part of this flow. Passwords protect local storage; they do not change
addresses. The chain, not a NIR account server, holds balances and transactions.

The experimental derivation is frozen by `tests/wallet-seed.test.mjs`:

1. Generate 256 random bits and encode them as 24 words using the BIP-39 English
   list and its 8-bit SHA-256 checksum. Reject unknown words and bad checksums.
2. Convert the canonical, NFKD-normalized mnemonic to the 64-byte BIP-39 seed
   with PBKDF2-HMAC-SHA512, 2048 iterations, salt `mnemonic`, and no optional
   BIP-39 passphrase. The app password is **not** the BIP-39 passphrase.
3. Derive each 32-byte ML-DSA-65 key-generation seed with HKDF-SHA512 using the
   BIP-39 seed as input, UTF-8 salt `NIR/ML-DSA-65/WALLET/V1`, and the account
   index as an unsigned 32-bit big-endian `info` value (0 through 2³¹−1).
4. Import that seed through the RFC 9881 ML-DSA-65 PKCS#8 seed form. Derive the
   SPKI public key and the ordinary NIR address from it. No new address or
   signature algorithm is introduced.

The BIP-39 English list and its upstream attribution are recorded in
`blockchain/bip39-english-LICENSE` under the MIT license. This mnemonic uses BIP-39 words but **NIR-specific
account derivation**; it is not a MetaMask or Trust Wallet account.

Before enabling this in any downloadable app: independently review the
derivation and word-list provenance, test create/restore on a clean Mac and a
different operating system, verify account 0/1/2 addresses and signing against
separate implementations, add explicit phrase-confirmation and local encrypted
storage, define account discovery after restore, and complete loss-of-device and
wrong-phrase tests. Existing randomly generated local-test addresses cannot be
regenerated from a new phrase; no code may silently claim to migrate them or
delete their local files.
