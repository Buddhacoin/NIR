# Proof-of-Progress economic-gaming boundary

This audit covers deterministic consensus rules, not a claim that a chain can
recognize intelligence or corporate independence. Seeded reference schedules
exercise candidate bonds, admissions, duplicate canonical content and lineage
deltas, conflicting claims, allocation order, expiry, restart, replay, and
safety-bounty settlements.

## Enforced bounds

- A progress submitter and reward recipient cannot be an exact registered
  validator, beacon, or evaluator address. Genesis still requires unique
  operator IDs across protocol roles.
- Every rewarded candidate keeps a finalized, admission-bound bond. Its
  allocated issuance cannot exceed that bond. The check is repeated while
  building and applying a block and the bond/commitment relation is checked on
  snapshot restore.
- Evaluator-reported `gainPpm` cannot exceed the independently recomputed
  world-frontier novelty delta. A weak historical baseline can no longer turn a
  small frontier movement into an arbitrarily weighted claim.
- Canonical content, behavioral commitment, artifact identity, fixed lineage,
  challenge seed, assigned committee, fingerprint, epoch, and network replay
  domains remain state-rooted. Conflicting same-block claims are applied to a
  staged capability memory in deterministic fingerprint order.
- A critical-safety settlement creates no progress issuance. Reporter and
  evaluator payouts come only from the candidate's locked bond, and at least
  20 percent of that bond is burned. Even if different addresses belong to one
  organization, farming its own bounty is a loss before external side effects.
- Committee assignment remains after finalized admission. Abandoning a bound
  attempt burns its full bond; an unbound bond gets no committee and is returned
  only after the fixed delay.

## Residual limits

The ledger distinguishes keys and declared operator IDs, not legal entities,
beneficial owners, employment relationships, hosting providers, or side
payments. One company can use unrelated keys, sponsor another address, buy
evaluators, censor competing claims, or share rewards off chain. Preventing the
exact protocol-role key from self-submitting closes a direct confusion path but
does not establish real-world independence or Sybil resistance.

The collateral ceiling limits issuance per attempt, but an accepted candidate's
bond is refunded. It is not a post-reward fraud bond, and consensus currently
has no objective proof that can claw back a reward when an evaluator quorum
colludes. SR-01 therefore remains critical: signatures authenticate statements,
not physical model execution, energy use, or honest measurements.

Challenge randomness is derived after commitment, but the chain cannot prove
that an off-chain task family was genuinely secret, unpredictable, broad, or
free of leaked training examples. Suite governance, isolated runners, task
rotation, hardware evidence, and external audits remain operational trust
boundaries.

Canonical bundle equality and behavioral commitments reject exact repeats;
they do not detect semantic copies, a one-byte transformation, split credit for
one conceptual improvement, or unreported common training lineage. The world
frontier prevents paying the same measured delta twice, but genuinely distinct
capability deltas controlled by one wealthy organization can still capture an
epoch. Fixed issuance intervals and the hard cap bound the rate, not market
concentration.

Safety-bounty burn makes self-funded vulnerability farming negative inside the
ledger, but does not price external publicity, sabotage, short positions, or
damage to users. The system must not describe this rule as proof that deliberate
vulnerabilities are economically impossible.
