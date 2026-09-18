# Ceremony-mode multi-validator finality drill

The automated drill exercises the real validator HTTP/TLS/P2P transport without
creating or using a development coordinator:

```sh
node --test --test-concurrency=1 tests/ceremony-multivalidator-drill.test.mjs
```

It creates an ephemeral valueless developer-testnet ceremony and four operator
targets. Every target has a distinct encrypted finality vault, encrypted
transport vault, pair of vault passwords, TLS certificate, TLS private key, and
ceremony activation generation. Vault passwords enter each validator process
only through its inherited descriptors 3 and 4. Validator and transport private
keys are never written as plaintext files.

The drill then performs these checks through the network services:

1. Start four `serve-validator` processes and confirm that no plaintext
   `VALIDATOR-KEY.json`, `TRANSPORT-KEY.json`, or coordinator authorization file
   exists.
2. Submit a valid 2-of-3 treasury transfer through public ingress. The elected
   validator obtains authenticated P2P prepare votes and commit votes, assembles
   the finality certificate, and broadcasts the block to all peers.
3. Read the finalized block over an authenticated P2P range request and verify
   the responder's transport signature plus prepare/commit quorum sizes.
4. Reject an unknown transport signer, a valid old certificate replayed over a
   different height-2 proposal, and a proposal from a finalized stale height.
5. Stop a non-proposer, finalize another valid transfer with the remaining
   three-node quorum, restart the stopped validator, and invoke its public sync
   path. Its height and tip must match the quorum.
6. Restart that validator once more and prove that the caught-up finalized tip
   survived process restart.
7. Recursively scan every ceremony generation and all process arguments,
   environments, and logs for vault passwords or validator/transport private
   keys.

The same drill also confirms that initialization fails closed when supplied a
genesis or signed source release different from the ceremony commitment.

This is a portable protocol and process-isolation drill. It does not claim that
four ephemeral local processes represent independent machines, operators, fault
domains, or production deployment readiness.
