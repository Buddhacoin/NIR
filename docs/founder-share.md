# Founder share

The founder receives 7% of the 21 million NIR supply in the main network's
genesis: 1% (210,000 NIR) is spendable at once and 6% (1,260,000 NIR) opens
linearly over ten years (see [`governance.md`](governance.md#creator-custody)).
Consensus enforces that schedule; nobody can move a locked part early. The
founder receives no share of mining rewards or transaction fees.

## The address

The share goes to a 2-of-3 address, not to an everyday wallet account:

- it is made from **three phrases of 24 words**, written on paper and kept in
  three different places;
- moving NIR from it needs **any two** of the three phrases;
- losing one phrase loses nothing, and one stolen phrase moves nothing.

NIR Wallet made it under **Settings → Founder share → Create the founder
address**. The card is shown only on a Mac that holds a founder descriptor,
so other users of NIR Wallet do not see it. Each phrase appears once in a macOS window (no copy button) and is
checked by asking two of its words back. The phrases are not stored anywhere;
NIR Wallet keeps only the public descriptor in `founder-share.json` in its
storage folder:

```json
{
  "address": "nir1…",
  "algorithm": "ml-dsa-65-multisig",
  "memberPublicKeys": ["…", "…", "…"],
  "threshold": 2,
  "vestingPolicy": {
    "allocationBps": 700, "durationMs": 315576000000,
    "immediateBps": 100, "model": "genesis-release-plus-linear"
  }
}
```

This is exactly the `founder` entry of a v5 genesis plan
([`genesis-ceremony.md`](genesis-ceremony.md)); **Copy the data for the network
launch** puts it on the clipboard. It contains no secret.
`blockchain/founder-share.mjs` makes and checks it. Each phrase derives its
member key the same way NIR Wallet derives account 0 from a phrase.

## Moving the open part

When the network NIR Wallet uses has this founder address in its genesis, the
card shows how much is still locked (`GET /v1/allocations`) and offers **Move
to myself**. The wallet asks for a confirmation and two different founder
phrases in macOS windows, signs a 2-of-3 transfer to its own active account
and submits it like any transaction. A transfer that would touch the locked
part is rejected by the network ("still vesting").

On the shared test network there is no founder share: its genesis has no
founder address, so the card says the address goes into the main network's
first block.

## Advice

- Create the address with Wi‑Fi off and nobody watching the screen.
- Never type the phrases anywhere except NIR Wallet's own macOS windows.
- Check that two phrases work before relying on them: the main network's launch
  will include the address only after this check.
