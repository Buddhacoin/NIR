# Security review — 2026-09

## Scope and conclusion

This internal white-box review covers key material and signatures,
serialization, consensus and peer-to-peer edge cases, the local wallet bridge,
supply, and fees. It is not an external audit, formal proof, or production
approval.

**Conclusion: do not carry real-value funds or declare a production launch.**
No direct signature forgery, supply-cap bypass, or unauthenticated bridge
signing path was demonstrated. Useful foundations include full SHA3-256
commitments, purpose-separated ML-DSA-65 signatures, exact payment-request
fields, and state-rooted accounting.

The critical risks are trust and operational risks: the protocol cannot prove
independent operators or remote model execution; its safety and randomness
services lack independently operated production deployment; and consensus lacks
a formal proof plus independent adversarial audit. A quantum-capable attacker
increases the urgency of transport and cryptographic-migration work; it does not
make ML-DSA-65 signatures an assumed break.

| Severity | Meaning |
| --- | --- |
| Critical | Blocks real-value launch or violates the core trust model. |
| High | Can cause major availability, privacy, integrity, or economic harm. |
| Medium | Requires operational controls before a public network. |
| Low | Defense-in-depth or implementation-hardening work. |

## Prioritized findings

### SR-01 — Critical: independent intelligence progress is asserted, not proven

**Affected:** `blockchain/chain.mjs` progress claims and receipts,
`nir/runner.py`, `nir/evaluator.py`, and `docs/protocol.md`.

**Reproducible scenario:** control enough registered evaluator identities, or
compromise their execution environment. Sign receipts saying that a candidate
and baseline ran in a prescribed environment even though the candidate was not
the committed artifact, the baseline was not run, or measurements were
fabricated. State transition checks signatures and deterministic receipt
arithmetic; it cannot observe physical execution.

**Current protections:** candidate/baseline hashes, suite commitments, delayed
challenge randomness, complete assigned committees, quorum receipts, duplicate
fingerprint rejection, policy vetoes, bonds, and reward-rate limits.

**Why critical:** a key proves who signed a statement, not that a separate
machine executed it. Energy evidence is self-reported. False independence could
make minted progress meaningless while all local consensus rules pass.

**Required closure:** independently operated isolated runners, hardware-backed
attestation bound to exact environment/artifact digest, independently metered
energy evidence, published challenge procedures, and external audit of the
admission-to-reward path.

### SR-02 — Critical: operator independence is not a code property

**Affected:** genesis registries in `blockchain/chain.mjs`,
`blockchain/operators.mjs`, `blockchain/validator-rotation.mjs`, and
`blockchain/beacon-service.mjs`.

**Reproducible scenario:** one organization provisions several key pairs and
operator IDs in genesis, then controls finality quorum or every selected beacon
or evaluator committee member. Key/ID uniqueness pass; that organization can
censor, halt, or approve its own false statements.

**Current protections:** different keys and IDs for consensus, evaluator, and
beacon roles; supermajority finality; delayed rotations with old/new overlap;
beacon bonds, disablement, and non-reveal penalties.

**Why critical:** code cannot determine common ownership, jurisdiction, hosting
provider, or coercion risk. Initial IDs are self-asserted. Bonds increase cost
only after sound distribution and liquidity exist.

**Required closure:** verified admission policy, independent legal and
infrastructure attestations, conflict disclosures, key ceremonies, withdrawal
delays, diversity requirements, incident playbooks, and public valueless testing
with independently administered operators.

### SR-03 — Critical: consensus safety and liveness are not formally established

**Affected:** `blockchain/distributed-node.mjs`,
`blockchain/consensus-view.mjs`, `blockchain/chain.mjs`, and durable vote files.

**Reproducible scenario:** combine a partial partition, delayed/replayed signed
messages, replacement proposer, restart near round change, and validator
rotation activation. Simulations help, but no machine-checked safety/liveness
proof covers all transitions. A subtle lock, certificate, or persistence edge
could halt the network or split honest implementations.

**Current protections:** separate prepare/commit certificates, durable
anti-equivocation files, highest-certified proposal selection, unique-vote
checks, state replay, authenticated peer messages, rotation joint quorums, and
bounded round numbers.

**Coverage command:**

```sh
node --test tests/adversarial-consensus.test.mjs tests/network-partition.test.mjs \
  tests/round-consensus.test.mjs tests/stateful-consensus-fuzz.test.mjs
```

Passing finite schedules is not proof over all schedules, restarts, clock skews,
and implementations.

**Required closure:** formally specify/model-check state transitions,
property-test wire and persistence boundaries, add independently reviewed
verification or a second implementation, and complete multi-host recovery drills.

### SR-04 — High: conventional TLS permits store-now, decrypt-later exposure

**Affected:** `blockchain/http-client.mjs`, `blockchain/node-service.mjs`, and
`docs/quantum-security.md`.

**Scenario:** a quantum-capable attacker records current TLS sessions and later
breaks conventional key exchange or certificate authentication. Confidential
payloads and metadata can be exposed; certificate-key recovery can enable
endpoint impersonation where application authentication does not cover a route.

**Current protections:** TLS 1.3, peer-registry certificate fingerprints, and
ML-DSA-signed peer requests/responses for consensus synchronization. Transport
break alone must not forge a validator vote or block certificate.

**Required closure:** prohibit vault material, model weights, and private data on
this transport; deploy reviewed hybrid post-quantum key establishment; retain
application signatures; rehearse certificate rotation and revocation.

### SR-05 — High: secrets are exposed to the local process after vault unlock

**Affected:** `blockchain/vault.mjs`, `blockchain/wallet-files.mjs`, and
`blockchain/wallet-bridge.mjs`.

**Scenario:** malware, debugger, crash dump, malicious local extension, or
compromised runtime reads a wallet process during signing. The encrypted file
can remain intact while plaintext key material is read from memory.

**Current protections:** AES-256-GCM, scrypt, canonical size checks,
authenticated metadata, no password argument, loopback/origin/token bridge
checks, one pending prompt, replay-limited request IDs, and session revocation.

**Required closure:** hardware signer or separate privileged signer process,
minimal and locked secret memory where supported, core-dump prevention, malware
threat model, and external implementation audit. Twelve characters is an input
floor, not high-entropy assurance.

### SR-06 — High: bridge security depends on a trusted browser origin

**Affected:** `blockchain/wallet-bridge.mjs`, `wallet-ui/app.js`, and
`wallet-ui/manifest.json`.

**Scenario:** malicious script executes in allowed page/extension origin after
pairing. It calls loopback bridge with the in-memory session token and presents
an intent to the human. Confirmation exists, but compromised display can
misrepresent recipient or amount.

**Current protections:** exact origin, loopback socket/Host checks, short-lived
pairing code, attempt limit, session token, one active request, replay IDs, no
wildcard CORS, strict CSP, and no browser-stored private keys/passwords.

**Coverage command:**

```sh
node --test tests/wallet-bridge.test.mjs tests/wallet-flow.e2e.test.mjs
```

**Required closure:** browser confirmation is not an independent trusted display.
Bind complete recipient/network/amount/fee to hardware signer or native window;
expire idle sessions; add reviewed update signing; disable bridge by default.

### SR-07 — High: randomness can halt; last reveal is an availability lever

**Affected:** `blockchain/operators.mjs` and epoch transitions in
`blockchain/chain.mjs`.

**Scenario:** selected authority waits for other reveals then withholds. The
protocol rejects alternate subsets, preserving unpredictability but stopping the
round until timeout. Repeated selected malicious members can delay challenge
assignment or exhaust eligible authorities temporarily.

**Current protections:** commit-before-reveal, reveal-after-commit-height,
deterministic selection, no manufactured timeout seed, deterministic
exclusion/retry, slashing, and disablement below required bond.

**Required closure:** independent authority deployment, adversarial-selection
and exhaustion modelling, published bond economics, monitored failover, and
authority-service audit. Penalized delay is not solved delay.

### SR-08 — Medium: wall-clock validation can fragment availability

**Affected:** `MAX_FUTURE_DRIFT_MS` in `blockchain/constants.mjs` and block
validation in `blockchain/chain.mjs`.

**Scenario:** proposer produces a block near its local time. Validators differing
by over 120 seconds reject it while others may vote. This should not form
conflicting finality without Byzantine quorum, but can reduce availability and
cause repeated view changes.

**Current protections:** timestamps are nondecreasing and future-bounded; reward
blocks use them for minimum issuance interval.

**Required closure:** publish clock synchronization/monitoring requirements,
measure drift in testnet, consider deterministic prior-finality-based acceptance,
and test skew alongside partitions.

### SR-09 — Medium: hostile-operator DoS controls are unproven

**Affected:** `blockchain/ingress-limiter.mjs`, `blockchain/peer-auth.mjs`, and
`blockchain/distributed-node.mjs`.

**Scenario:** authenticated malicious peer sends distinct signed requests or
costly valid-looking payloads near limit. Cryptographic verification precedes
higher-level rejection. Nonce maps prune on later requests, and source identity
is imperfect behind shared infrastructure.

**Current protections:** bounded bodies, connection/header/time limits, token
bucket rate limiter, short replay window, and peer authentication.

**Required closure:** measure CPU/memory around signature work; add per-identity
and global concurrency limits, timer-based bounded nonce cleanup, peer
reputation/quarantine, proxy-aware policy, and stress testing.

### SR-10 — Medium: canonical serialization needs normative byte encoding

**Affected:** `blockchain/crypto.mjs` (`canonicalJson`) and all signed/hashed
object callers.

**Scenario:** future caller hashes data outside JSON-shaped discipline, such as
`undefined`, non-finite numbers, exotic prototypes, or accessors. The compact
serializer is not a general canonical-data standard. Cross-language code could
disagree on signature, transaction ID, or root bytes.

**Current protections:** consensus validates many fields, remote payloads are
normally JSON, payment requests have exact fields, and domains are separated.

**Required closure:** specify normative bytes, reject non-JSON values and unknown
fields at consensus envelopes, publish language-neutral vectors, and require
independent reproduction.

### SR-11 — Medium: economics lacks demonstrated adversary-cost model

**Affected:** `blockchain/constants.mjs`, bonds, transfer-credit stake, and fee
handling in `blockchain/chain.mjs`.

**Scenario:** before liquidity and operator distribution exist, attacker controls
enough of small active bonded set to censor, delay beacons, or dominate upgrades.
Fixed fees and credits bound some spam but their real cost is unknown without
market depth, load tests, and operating-cost data.

**Current protections:** hard cap, treasury vesting, minimum fees, per-block
transaction/credit caps, bonds, defined slashing, and issuance rate limit.

**Required closure:** publish a model for value-at-risk, concentration,
liquidity, unbonding, operator cost, fee market, and adversarial load; simulate
griefing and censorship at multiple network sizes.

### SR-12 — Low: cryptographic agility is not on-chain

**Affected:** `blockchain/constants.mjs`, `blockchain/crypto.mjs`, and
`docs/quantum-security.md`.

**Scenario:** material weakness is found in active signature suite/runtime. A
coordinated update is needed, but no rehearsed on-chain account/validator key
migration retires old suite safely.

**Current protections:** explicit algorithms and protocol version, key-type
inspection, and full hash outputs with substantial generic quantum margin.

**Required closure:** design and rehearse suite migration with dual
authorization, expiry, recovery, test vectors, and governance thresholds.

## Positive properties verified by inspection

- Full SHA3-256 public-key digest is used for addresses; no short identifier.
- Signatures and hashes use different domains for transfers, blocks, payment
  requests, peer messages, and vault checks.
- `verifyObject` checks actual key type rather than trusting a label.
- Transactions validate network, nonce, signature, balance, fee/credit rule,
  duplicate IDs, transaction root, and hard supply cap.
- Wallet bridge checks origin, loopback peer, Host, token, content type, bounded
  input, explicit authorization, and replay IDs; it has no raw-key endpoint.
- Payment requests require exact fields, recipient/key binding, network,
  signature, and expiration before UI use.
- Light-client finality checks header continuity, handoffs, and prepare/commit
  quorum before account or transaction proof acceptance.

## Required release gates

1. Close SR-01 through SR-03 with independently audited multi-operator evidence.
2. Complete hybrid post-quantum transport and suite-migration design.
3. Perform external cryptographic, wallet, consensus, implementation, and
   economic audits; publish remediation and retest results.
4. Run valueless public testnet with hostile-network exercises, clock skew,
   restore/failure drills, key-compromise simulation, and independent operators.
5. Do not authorize custody, sales, exchange use, or production-readiness claims
   until critical findings have evidence-backed closure.

## Review limits

This reflects repository state reviewed on 2026-09-17. Absence of demonstrated
exploit is not evidence of absence; this report becomes stale after code or
parameter changes.
