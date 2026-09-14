# NIR privacy direction

Privacy is necessary for ordinary money: salaries, purchases, donations, and a
person's complete financial history should not automatically become a public
profile. NIR should pursue selective financial privacy rather than promise
untraceable activity under every circumstance.

## Desired payment properties

- public verification that no value was created beyond consensus rules;
- hidden sender, recipient, amount, and wallet graph for shielded payments;
- commitments and nullifiers that prevent hidden double spending;
- diversified receiving addresses so repeated payments are not trivially linked;
- a spending key that alone can move funds;
- an incoming viewing key for proving receipts;
- a full viewing key the owner may voluntarily give to an auditor or accountant;
- transaction-specific payment disclosure without revealing the whole wallet;
- no universal administrator decryption key or hidden protocol backdoor.

Progress mining has a different privacy boundary. Monetary rewards may be paid
to shielded addresses, while capability claims still need public commitments,
deduplication nullifiers, safety-policy identifiers, and enough evidence for
independent reproduction. Private model weights and dangerous exploit details
should remain encrypted and be disclosed only to assigned evaluators.

## Why not copy an existing shielded protocol unchanged

NIR uses post-quantum signatures, but that alone does not make a shielded
payment construction post-quantum secure. The zero-knowledge proof system,
commitments, note encryption, viewing keys, parameter generation, and migration
path all require a separate quantum and implementation review. No shielded
scheme has been selected yet.

## Regulatory boundary

Privacy at the protocol layer does not guarantee exchange access. Regulated
custodians can be required to identify customers and may decline privacy-focused
assets. For example, Article 79 of EU Regulation 2024/1624 restricts covered
crypto-asset service providers from maintaining accounts that anonymize holders
or increase transaction obfuscation, including through anonymity-enhancing
coins.

Primary text: https://eur-lex.europa.eu/eli/reg/2024/1624/oj

Viewing keys and payment disclosures can support voluntary accounting and
compliance, but they do not guarantee that every jurisdiction, bank, or exchange
will support NIR. The protocol should protect self-custody without marketing
itself as a tool to evade lawful obligations.

## Required research before implementation

1. select a post-quantum-compatible proof and note-encryption construction;
2. specify public supply conservation across transparent and shielded pools;
3. design viewing-key scopes and transaction-specific disclosures;
4. prevent metadata leaks through network addresses, timing, fees, and change;
5. benchmark proof creation on ordinary phones and laptops;
6. commission cryptographic and jurisdiction-specific legal reviews;
7. launch only with valueless test units and an explicit migration path.
