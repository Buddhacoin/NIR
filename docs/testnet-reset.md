# Testnet reset and incident planning

The reset tool prepares and rehearses a new valueless testnet identity. It does
not stop nodes, remove a data directory, overwrite a genesis file, replace a
published network, or execute a reset. Any destructive operational action needs
a separate, reviewed manual process outside this tool.

## Reset manifest

`nir-testnet-reset-v1` binds exactly these reviewed facts:

- the old genesis hash and old network ID;
- a distinct new genesis hash and new network ID;
- the SHA3-256 commitment to the incident report bytes;
- a millisecond Unix `notBefore` timestamp;
- an explicit bounded reason.

Unknown fields, malformed values, equal old/new network IDs, and equal old/new
genesis hashes are rejected. The manifest hash is domain separated. Approvals
are ML-DSA-65 signatures from the validator registry in the old genesis and
require `floor(2N/3) + 1` distinct validators. Unknown validators, duplicate or
unordered approvals, and invalid signatures fail closed.

The old genesis file is the trust anchor. Operators must obtain it through an
already authenticated channel and compare its published fingerprint before
planning or signing. A quorum signature proves authorization by those validator
keys; it does not prove that the operators are independent organizations.

## Plan and collect approvals

Create a new genesis file without modifying the old one, write a detailed
incident report, and create an exact request:

```json
{
  "notBefore": 1790000000000,
  "reason": "Reset the valueless testnet after the documented key compromise."
}
```

Produce the unsigned plan on standard output:

```bash
npm run testnet:reset -- plan \
  old-genesis.json new-genesis.json incident-report.md reset-request.json \
  > reset-plan.json
```

Each old-network validator reviews all inputs and appends one approval. The
vault password is accepted only from an interactive terminal:

```bash
npm run testnet:reset -- sign \
  old-genesis.json reset-plan.json validator-1.nir > reset-plan-1.json

npm run testnet:reset -- sign \
  old-genesis.json reset-plan-1.json validator-2.nir > reset-plan-2.json

npm run testnet:reset -- sign \
  old-genesis.json reset-plan-2.json validator-3.nir > reset-signed.json
```

The signer must independently inspect the old and new genesis files, incident
report hash, activation time, reason, and previous approvals before entering a
vault password. Shell redirection must target a new file, never an input file.

## Verify and drill

Verification recomputes both genesis hashes and the incident-report commitment,
checks the old validator quorum, and refuses the manifest before `notBefore`:

```bash
npm run testnet:reset -- verify \
  old-genesis.json new-genesis.json incident-report.md reset-signed.json
```

The drill requires a new directory in a regular parent:

```bash
npm run testnet:reset -- drill \
  old-genesis.json new-genesis.json incident-report.md reset-signed.json \
  /absolute/path/to/new-reset-drill
```

It writes private input copies and `RESET-DRILL.json` only inside that new isolated
directory. Evidence records that the old genesis bytes were unchanged before
and after the rehearsal, the old transaction signature verifies only for the
old network payload, the same signature fails for the new network ID, and no
live data was touched. The tool refuses an existing target and exposes no wipe,
replace, apply, execute, or reset-data command.

## Operational boundary

This closes a local planning and failure-test gap, not the incident-response
gate. Before a public developer testnet, independent operators still need to
rehearse communication, quorum review, publication of the new fingerprint,
safe shutdown, evidence retention, and any explicitly approved retirement of
old testnet hosts. Production or real-value networks require a separately
audited governance and recovery process.
