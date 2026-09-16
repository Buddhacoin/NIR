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
The wallet interface does not expose these controls yet; current use is through
the protocol API and valueless local network.
