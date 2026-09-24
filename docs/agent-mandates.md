# Agent Mandates — Stage 1 specification and Stage 2 model

This document specifies the first safety boundary for software agents that may
request NIR payments, bounded trades, or participation in intelligence-mining
workflows. Stage 1 is the public design target. Stage 2 now provides a normative,
non-consensus state machine in JavaScript and Rust plus shared vectors for one
narrow payment subset. This does not enable mandates in the chain or wallet.

The executable Stage 2 subset only supports escrowed NIR transfers. An owner
locks a fixed balance for a separate agent, fixes `allowedPayees`,
`maxPerTransfer`, `totalLimit`, `maxFee`, `totalFeeLimit` and an expiry height,
and may revoke the mandate or close it after expiry to recover the remaining
escrow. Every authorization is bound to one canonical network identifier. The
registry is capped globally and per owner; permissionless deterministic cleanup
returns expired escrow to its owner without paying the caller. Authorization is
accepted only through an explicit preverified boundary: Stage 2 deliberately
does not define or verify signed transaction schemas. Controller sets, trading,
freeze, recovery, simulation, receipts and protocol-v26 authenticated state
remain planned rather than implemented.

## User scenario

A person or organization controls an account through its normal controller and
recovery keys. The controller may issue a short-lived mandate to a separate
agent key, for example: pay approved infrastructure providers for seven days,
never spend more than a fixed amount or fee budget, make no more than twenty
operations per epoch, and stop immediately when the mandate is revoked.

The agent receives only that mandate key. It never receives the account root,
controller or recovery keys. It may propose a typed intent, but a separate
policy engine simulates the exact operation and a separate signer authorizes
only the resulting transaction bytes. An unknown action, stale simulation,
unavailable policy check or exhausted limit is a rejection, not a request for
the agent to improvise.

## Planned protocol-v26 schemas (not implemented)

All integers below are non-negative safe integers unless stated as decimal
atomic-unit strings. IDs and roots are 64 lowercase hexadecimal characters;
addresses and public keys use the existing canonical NIR formats. Objects have
exact fields: unknown, missing or duplicate fields are invalid.

`nir-agent-controller-set-v1`:

```text
{ format, account, generation, controllers[], threshold, recoveryPolicyHash }
controller = { address, algorithm, publicKey }
```

Controllers are strictly ordered by address and unique by address and public
key. `threshold` is between one and the controller count. A generation must be
exactly one greater than its predecessor.

`nir-agent-mandate-v1`:

```text
{
  format, account, mandateId, controllerSetId, delegate,
  notBeforeHeight, expiresAtHeight, policyEpoch,
  actions[], counterpartyRoot,
  maxAmountPerOperationAtomic, maxAmountPerEpochAtomic,
  maxFeesPerOperationAtomic, maxFeesPerEpochAtomic,
  maxOperationsPerEpoch, epochLengthBlocks, minimumRemainingAtomic
}
delegate = { address, algorithm, publicKey }
```

`actions` is a strictly ordered non-empty subset of initially supported native
actions such as `transfer` and `trade-intent`. Mining actions are deliberately
absent. `counterpartyRoot` commits to the approved counterparty set; every
operation carries its membership proof. `mandateId` is the domain-separated
hash of every mandate field except `mandateId` and cannot be selected by the delegate.
The controller threshold signs the exact mandate.

`nir-agent-operation-v1`:

```text
{
  format, account, mandateId, policyEpoch, mandateNonce,
  action, counterparty, amountAtomic, maximumFeeAtomic,
  expiresAtHeight, intentHash, simulationHash, payload
}
```

The delegate signs the complete operation. `payload` has an exact action-specific
schema and may not contain another encoded transaction or authority. A native
simulation deterministically commits to the pre-state root, complete state
diff, fee, post-operation balance and operation hash.

`nir-agent-mandate-revocation-v1`:

```text
{ format, account, mandateId, controllerSetId, policyEpoch, effectiveHeight, reasonHash }
```

Revocation requires the active controller threshold. Emergency freeze is a
separate account operation that may only stop agent operations; it cannot move
funds, change controllers or release a frozen mandate.

`nir-agent-operation-receipt-v1`:

```text
{
  format, account, mandateId, mandateNonce, action, intentHash,
  simulationHash, policyDecisionHash, transactionId,
  finalizedHeight, finalizedBlockHash, postStateRoot, status
}
```

`status` is one of `finalized`, `rejected` or `expired`. A finalized receipt is
derived from verified chain data. Rejection and expiry receipts are signed by
the wallet/operator policy engine and are not consensus claims.

## Planned authenticated chain state (not implemented)

Protocol v26 is intended to add these consensus-authenticated maps and counters:

```text
agentControllerSets[account] -> active set and generation
agentPolicyEpoch[account] -> integer
agentMandates[mandateId] -> mandate, status, issuanceHeight
agentUsage[mandateId] -> epoch, amountAtomic, feesAtomic, operations, nextNonce
agentRevocations[mandateId] -> effectiveHeight and reasonHash
agentFreeze[account] -> frozenUntilHeight or indefinite freeze marker
```

Issuance, use, revocation, expiry, budget accounting and the underlying payment
or native trade state transition must be atomic. A failed operation consumes no
budget or nonce. Recovery or controller rotation increments `policyEpoch`, which
invalidates every older mandate without enumerating them.

## Target consensus invariants (not active)

Every full node must enforce all of the following before an agent operation can
change state:

1. the mandate exists, is active, is within its height window and matches the
   account's active controller set and policy epoch;
2. the delegate signature, network domain, action, exact payload and monotonic
   mandate nonce are valid;
3. the counterparty proof matches `counterpartyRoot`, and the counterparty is
   not the same account, delegate or deterministically controller-linked account;
4. per-operation and per-epoch amount, fee and operation-count limits remain
   within bounds, including the current operation;
5. the post-operation balance is at least `minimumRemainingAtomic`;
6. the deterministic native simulation hash matches the exact pre-state and
   transition being finalized;
7. revocation, freeze, expiry, recovery and controller rotation take priority
   over an otherwise valid pending operation;
8. an agent cannot issue, widen, renew, revoke or recover its own mandate.

No validator, wallet or application may silently treat an ordinary signature
as an agent mandate or infer authority from natural-language text.

## Threat model

| Threat | Required control |
| --- | --- |
| Prompt injection | Natural-language output creates only an intent; a typed policy engine and isolated signer construct authority-bearing bytes |
| Stolen tool authority | Separate mandate key, narrow action list, network/account binding, short expiry and immediate controller revocation |
| Runaway spending | Per-operation, per-epoch, fee, count and minimum-balance limits enforced by consensus |
| Wash trading and self-dealing | Approved-counterparty proofs, deterministic linked-controller rejection, receipts and off-chain beneficial-control review |
| Fake useful work | Separate mining authority, fresh hidden challenges, reproducible receipts, independent assignment and delayed reward |
| Collusion | Distinct role keys and controller sets, random post-commit assignment, signed evidence, bonds and dispute windows |
| Key exfiltration | Non-exportable or process-isolated signer; no root/recovery key in the agent runtime, prompt, environment or log |
| Market manipulation | Position, price, slippage and venue limits in the wallet/operator policy; deterministic native limits where consensus has the required data |
| Responsibility ambiguity | Every operation binds the account, controller set, policy epoch, mandate and delegate; the controller remains responsible for issuance |
| Recovery abuse | Delayed threshold recovery, visible pending change, emergency freeze, policy-epoch invalidation and no agent role in recovery |

## Payments, trading and mining are separate

A payment mandate moves existing NIR under bounded authority. It never creates
NIR and cannot submit a mining candidate, evaluate its own work, author a hidden
challenge or collect a mining reward.

Mining uses a future `nir-mining-contributor-mandate-v1` with a distinct key,
bond, role and assignment lifecycle. Direct reuse of a payment delegate,
controller set or candidate key as an evaluator must fail in consensus where
the relationship is objectively visible. Organizational ownership, hidden
coordination and beneficial control require operator disclosure and independent
review because a deterministic ledger cannot infer them reliably.

An agent claiming useful work receives no immediate reward. Candidate
commitment, fresh assignment, reproducible execution, safety result, dispute
window and reward escrow remain mandatory. Deliberately unsafe work, repeated
content, self-evaluation and circular payment activity do not become useful
work merely because an agent signed them.

## Consensus and wallet/operator boundary

Future consensus can and should enforce exact keys and schemas, issuance signatures,
scope, height expiry, nonces, budgets, fees, operation counts, authenticated
counterparty-set membership, native simulation binding, revocation, freeze,
policy-epoch invalidation, reward escrow and objectively provable role conflicts.

Wallet and operator software must enforce prompt isolation, process or hardware
key custody, human-readable review, stricter daily limits, anomaly detection,
market-price and slippage sources, organizational relationship checks,
notifications, detailed private receipts and emergency response. These controls
may reject more operations but can never weaken consensus limits.

## Staged rollout

1. **Stage 1 — public specification — complete:** this document fixes
   terminology, schemas, invariants and trust boundaries. No chain or wallet
   authority exists.
2. **Stage 2 — executable non-consensus model — complete locally:** deterministic
   JavaScript and Rust implementations and shared vectors cover only escrowed
   transfers to allowed payees with per-transfer, cumulative-spend,
   per-operation-fee, cumulative-fee and expiry limits, plus owner revocation,
   expiry close and bounded deterministic cleanup. Signed intents are bound to
   one network; authoritative inclusion height and fee recipient remain trusted
   execution context. Authorization is preverified by the caller; signed
   schemas, proofs, snapshots and transaction simulation are not part of this
   model.
3. **Stage 3 — protocol-v26 valueless activation:** gate mandate state behind an
   explicit delayed upgrade; test issue, use, exhaustion, revocation, freeze,
   recovery and replay across restart and validator rotation.
4. **Stage 4 — wallet and signer:** ship typed intents, exact simulation,
   controller approval, isolated mandate keys, receipts and emergency revocation.
5. **Stage 5 — adversarial public testnet:** test injection, stolen delegates,
   concurrent budget races, self-dealing, collusion, recovery and long-running
   operator failure before any real-value consideration.

Protocol version 26 is a proposed activation target, not an active or guaranteed
version. The current chain and wallet do not recognize the Stage 2 state or its
vectors. No stage may be skipped because a local demonstration passes.

## Limitations

Mandates limit authority; they do not prove that an agent is correct, honest,
profitable, independent or safe. Counterparty commitments do not reveal hidden
common ownership. Simulation covers specified deterministic state, not every
off-chain consequence. Recovery cannot undo a finalized valid operation.

NIR has no public agent service, agent-mining market or profit program. This
specification promises no income, price, liquidity, reimbursement or protection
from every loss. The Stage 2 model is not a safe signer or deployable account
feature. Until signed schemas, consensus integration, wallet controls and an
independent audit are complete, an AI must not be given a funded NIR mandate.
