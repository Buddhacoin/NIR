# Participation and incentives

## Open wallet testing — no invitation required

Ordinary users should not need a personal invitation, whitelist, or manual
account approval to test NIR. Today, anyone can inspect the source and report
problems with the local wallet preview. The self-service path for a shared
public testnet is **not live yet**; it must include a verified download,
automatic network configuration, a rate-limited test faucet, a guided first
transaction and recovery drill, and a simple feedback route before it is
advertised as ready. See the [open tester plan](open-wallet-testing.md) and
[wallet guide](wallet.md). Never send anyone a private key, password, or backup.

## Public developer-testnet operator pilot

This separate infrastructure rehearsal needs named, independently controlled
validator, beacon, and archive operators. It is **not** a gate on ordinary
wallet testers. NIR is preparing a closed, test-only multi-host rehearsal before any public
developer-testnet endpoint is announced. Expressing interest does not require
buying NIR, sending funds, exposing a private key or operating a real-value
service. Test units have no monetary value.

The initial cohort needs independently administered roles:

- four validator operators, each controlling its own machine, finality vault,
  transport key and TLS private key;
- at least four beacon operators with separate keys and failure domains;
- at least two archive operators retaining independently administered backup
  copies and performing isolated restore drills;
- at least two security reviewers who do not share administration with the
  validator quorum.

One person may volunteer for the rehearsal, but identities controlled by one
person or organization do not count as independent operators. The protocol can
prove that keys and signatures are distinct; it cannot prove who controls them.

An operator should be able to provide a dedicated or safely isolated computer,
stable connectivity, current system updates, Node.js 26+, several hours for a
scheduled rehearsal, encrypted offline backup media, and a public contact for
incident coordination. No participant should ever send a vault file, password,
seed, private key or remote-administration credential to another participant.

The cohort proceeds only in this order:

1. review the valueless/resettable scope and the canonical
   [gate matrix](public-testnet-gates.md);
2. independently verify a signed release and create keys locally;
3. exchange only public identities, endpoints and certificate fingerprints;
4. complete host preflight before exposing a service;
5. run the private multi-host rehearsal and failure drills;
6. publish signed evidence hashes and limitations for independent review;
7. open a public developer testnet only after every required gate passes.

The detailed validator procedure is in
[validator-ceremony-onboarding.md](validator-ceremony-onboarding.md). Network
operations are documented in [network.md](network.md), and the current launch
boundary is maintained in [launch-readiness.md](launch-readiness.md).
A [preparation-only volunteer intake template](volunteer-operator-intake.md)
is available; it is not an open call for operators.

Frontier-model training will often require organizations with substantial
compute. NIR therefore separates invention from the other work needed to prove
and secure it. A production reward can compensate several roles:

- the author of a new capability or efficiency improvement;
- independent operators who reproduce the result;
- people who create fresh, objectively gradable challenge families;
- safety researchers who discover critical failures;
- challengers who prove a forged evaluation, duplicated lineage, or collusion;
- node operators who relay and validate ordinary payments.

An individual does not need to train a foundation model to participate. Useful
small-model improvements, algorithms, tools, adversarial tests, benchmark
generators, reproducibility work, and security findings can be contributions.
The protocol must measure their outcome rather than reward raw activity, or it
will create spam markets.

Safe progress and safety discovery are separate proof markets. A laboratory's
candidate receives a progress reward only after clearing the approved safety
policy. An investigator who reproduces a critical failure can receive a
bounded bounty from a pre-funded security pool or objectively slashed bonds;
the unsafe candidate receives no issuance. Security reports must be committed
before disclosure, independently reproduced, severity-scored, and deduplicated.
Otherwise participants could repeatedly report the same issue or deliberately
create vulnerable artifacts to farm rewards.

The safety-penalty prototype makes deliberate vulnerability farming a losing
strategy even when several addresses secretly belong to one coalition. A
confirmed critical failure creates no currency: 70 percent of the candidate's
bond goes to the reporter, 10 percent to independent evaluators, and at least
20 percent is burned. Therefore a coalition controlling the submitter, reporter,
and evaluators can recover at most 80 percent of its own bond before execution
costs and transaction fees.

The current core sends an intelligence reward to the accepted contribution
recipient and sends transaction fees to the block proposer. A multi-role reward
split is a design proposal and is not yet a consensus rule. Address-based caps
are not a Sybil defense: one organization can create unlimited addresses.

Companies may participate for token rewards, but also for a public proof of
capability, safety certification, access to an evaluator network, reputation,
and a neutral way to license or sell verified improvements without publishing
private weights. These incentives only become meaningful if users and AI
services actually demand NIR; protocol design alone cannot create that demand.

In a v4/v5 genesis, the founder receives 7 percent and the separate public
protocol treasury 5 percent of fixed supply. The founder's first 1 percent of
total supply is spendable at genesis; the other 6 percent vests linearly for
ten years. V5 also makes 0.1 percent of total supply from the treasury
available at genesis for a possible future tester program and vests the other
4.9 percent. This does not activate or promise any payout. V4 keeps all 5 percent
treasury vesting linearly. Neither depends on the founder
personally mining intelligence rewards. V3 keeps its older fully linear
founder schedule.
The founder has no automatic share of transaction fees. Both permanent
multisignature addresses still need offline creation, recovery testing, and
publication in a signed genesis before a real-value network can launch.
