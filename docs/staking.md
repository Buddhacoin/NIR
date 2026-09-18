# NIR resource staking and Transfer Credits

NIR resource staking locks native NIR to obtain renewable payment capacity. It
does **not** promise interest, yield or newly issued coins. The benefit is the
right to submit a bounded number of zero-fee transfers or provide that capacity
to another account without giving it control of the locked NIR.

## Current protocol-v19 parameters

- reference stake unit: `100 NIR`;
- allowance: `10` transfers per `100 NIR` every `720` blocks, calculated
  proportionally and rounded down to a whole transfer;
- maximum credit-paid transfers in one block: `100`;
- unstake delay: `64` blocks after the request;
- ordinary NIR fees remain available when credits are exhausted.

These are test-network parameters. Production values require public load and
economic measurements.

The quota is computed from the owner's total locked atomic stake and rounded
down once per account. Splitting the same stake across more addresses can only
preserve or reduce the combined quota; it cannot create credits. Direct,
sponsored and delegated transfers all increment the same owner/epoch usage
counter. Each delegated transfer additionally increments that delegate's
smaller allowance, so mutual or cyclic delegations do not duplicate capacity.
An allowance update cannot be reduced below credits already spent in its
current epoch; revocation to zero remains immediate for later blocks.

This is bounded resource pricing, not a complete DoS or decentralization
solution. A wealthy operator can lock more NIR, distribute traffic across many
accounts and use the global 100-transfer block allowance before smaller users.
Aligned 720-block epochs also permit a bounded burst at the boundary: the last
old-epoch block and first new-epoch block may each consume a full allowance.
Validators can still censor transactions, and current credit traffic does not
pay the proposer. Production parameters therefore require measured load,
fair-queueing/mempool policy and an explicit validator-compensation policy.

## Use it in the local wallet

1. Start the local node, wallet preview and signing bridge as described in the
   main README.
2. Pair the encrypted vault with the one-time code shown by the bridge.
3. Open **Resources** in the bottom navigation.
4. Choose an amount to lock, enter an address and per-epoch delegation limit,
   or begin an exit from the locked balance.
5. Compare the action, network, amount or delegation, fee and nonce printed by
   the bridge. Type `SIGN` and enter the vault password only in that terminal.
6. Inspect the signed JSON in the wallet, then use the separate submit button.
   The wallet repeats the network check, submits only to the connected valueless
   local network and refreshes locked stake, credits and pending unlock height.

The browser never receives the private key or password. Every signing request
has a one-use identifier, and the bridge accepts only its exact paired origin.

## Stake

The account signs a `credit-stake` transaction. The amount leaves its spendable
balance and enters consensus-tracked locked stake. Credits renew lazily at the
next block epoch; unused credits do not become NIR and cannot be sold as a
second currency.

```js
const transaction = createCreditStake({
  wallet,
  networkId: "nir-testnet",
  amount: (100n * 100_000_000n).toString(),
  nonce: chain.nextNonce(wallet.address),
});
```

## Use a credit directly

```js
const transaction = createCreditTransfer({
  wallet,
  networkId: "nir-testnet",
  recipient,
  amount: "100000000",
  nonce: chain.nextNonce(wallet.address),
});
```

The signature binds the network, sender, recipient, amount, nonce and resource
mode. Changing a fee-paid transaction into a credit transaction invalidates the
signature.

## Sponsor one exact payment

A service can co-sign one complete user-authorized transfer with
`createSponsoredTransfer({ useCredits: true })`. Both nonces advance. The
service spends one credit but never receives authority over the user's balance.

## Create a standing allowance

The stake owner signs `createCreditDelegation` with a delegate address and a
per-epoch transfer limit. The delegate can then name that owner in
`createDelegatedCreditTransfer`. Consensus enforces both the owner's total
credit quota and the delegate's smaller allowance.

Set the delegation limit to `0` in a later signed transaction to revoke it.
Revocation affects all later blocks; it cannot reverse an already finalized
payment. If the owner has no spendable balance, a revocation may take its
minimum fee from the locked stake, so a fully staked account can still cut off
a compromised delegate.

## Unstake safely

1. Sign `createCreditUnstakeRequest` for the amount to exit.
2. The amount stops producing credits immediately.
3. The protocol deducts the ordinary transaction fee from the requested stake,
   so a fully staked account is not trapped without a liquid fee balance.
4. Wait until the recorded `unlockHeight`.
5. Sign `createCreditUnstakeClaim`; the unlocked amount returns to the
   spendable balance.

Only one exit request per account may be pending. A premature claim is rejected.
The local wallet enables the claim button when the connected node reaches the
recorded unlock height.
