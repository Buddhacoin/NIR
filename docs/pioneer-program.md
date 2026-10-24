# Pioneer program

Decided by the founder on 2026-10-23. People who mine on NIR's test network
before the main network launches receive real NIR at its launch.

## The pool

- **210,000 NIR**, 1% of the 21,000,000 NIR supply, set aside in the main
  network's genesis for pioneers.
- It comes out of the miners' share: the main network's mining pool becomes
  **87%** (18,270,000 NIR) instead of 88%. The founder's 7% and the community
  fund's 5% do not change.
- The emission schedule does not change either (44 NIR per reward period of at
  least ten minutes, halving every 210,000 periods). The hard cap ends mining
  issuance that much earlier.
- The test networks that run today keep their current rules. The split applies
  to the main network's genesis plan.

## Points

- An address earns **one pioneer point per NIR of proof-mining rewards** paid
  to it on the shared test network (`nir-shared-testnet-1` and test networks
  that replace it and are named here).
- Faucet coins, transfers between addresses and name payments earn nothing.
  Only solved tasks count.
- Points come from the network's own record of rewards, which anyone can
  recompute from the blocks. Before a test network is reset, the points of
  every address are published as a signed snapshot and carried over.
- The founder's addresses and the test network's operator keys earn no points:
  the founder runs today's single test host and must not be able to pay himself
  from this pool.

## Seeing your points

NIR Майнер shows them on the shared network: the points of the address that
receives its rewards, today's share of the pool and what that share would be
worth in NIR if the pool were shared now. The node serves the same figures at
`GET /v1/pioneers/<address>` (`points` and `totalPoints` in atomic units,
`pioneers` = addresses with points). It counts every proof reward ever paid,
not only the 200 most recent ones a wallet's history keeps, and leaves out the
node operator's own keys. It is an index next to the chain, rebuilt from the
blocks after a restart, not consensus state.

The whole network's figures are at `GET /v1/stats`: `miners` (miner keys
that joined through the faucet, one per installed NIR Майнер), `pioneers`,
`minedNir` (all NIR paid for proofs) and `names`. nircoin.com shows them in
its ticker.

## At launch

- Each address receives `210,000 × its points ÷ all points` NIR, at the same
  address. The keys are the same, so **keep your 24 words**.
- The allocation is part of the published genesis inputs and can be checked by
  anyone before the main network starts.
- Points end at a cut-off date announced at least 30 days in advance.
- Points earned by exploiting a bug, as opposed to reporting it, may be
  excluded. Exclusions are listed publicly with the reason.

## What this is not

- **Not a sale.** Nobody buys NIR or points. The only way to earn is to mine.
- **Not a price promise.** The pool fixes an amount of NIR, not a price; what
  NIR is worth is decided later by the people who use it.
