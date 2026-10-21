# Account names

From protocol version 38 an address can have one short name, so people can
send NIR to `sasha.nir` instead of a 68-character address. The address stays
the account's identity: exchanges and other wallets keep using the address,
and wallets always show the full address a name stands for before sending.

The rules live in `blockchain/name-registry.mjs`; the chain applies them in
`NirChain` (`name-*` transactions).

## Rules

- **Characters.** 3–32 characters: `a`–`z`, `0`–`9` and single hyphens inside
  the name. Upper case, other alphabets and look-alike characters are not
  allowed, so two names cannot look the same. Wallets accept `Sasha.nir` and
  read it as `sasha`.
- **Reserved.** Names starting with `nir` and names such as `support`,
  `admin`, `official`, `wallet` or `treasury` cannot be registered, so nobody
  can pose as NIR or its staff.
- **First come, first served.** The owner first sends `name-commit` with a
  hash of the name, their address and a random salt, then at least two blocks
  later `name-register` with the name and salt. Someone who sees the
  registration in flight cannot take the name: they would need their own
  commit made earlier, and the commit binds the owner's address. Unused
  commits expire after 256 blocks.
- **One name per address.** Registering another name frees the old one at
  once. `name-release` frees it; `name-transfer` gives it to an address that
  has no name yet.
- **Kept until changed.** There is no renewal and no expiry.
- **Price.** Paid once and burned: nobody receives it, the founder and the
  validators included. 5 or more characters: 1 NIR; 4 characters: 10 NIR;
  3 characters: 50 NIR. Each transaction also pays the ordinary fee.

## Showing names

A wallet shows a name for an address only when both directions agree: the
name points to the address (`GET /v1/names/<name>`) and the address points
back to the name (`GET /v1/accounts/<address>/name`). When sending to a name,
NIR Wallet shows `sasha.nir → nir1…` with the full checksummed address.
`GET /v1/names` tells whether names are active on the network.

## In NIR Wallet

Settings → "Name on the network": type a name, see whether it is free and its
price, and press "Buy name". The Mac window shows the name and the burned
price; one password signs both the hidden commit and the registration, and
the wallet sends the second one when the network is ready (about a minute).
"Release name" frees it.

## Devnet

A proof-mining devnet starts on version 38. A devnet made by an older version
upgrades itself with its own release keys when NIR Майнер opens it.
