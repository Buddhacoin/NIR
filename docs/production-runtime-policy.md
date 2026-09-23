# Production wallet runtime policy

Production wallet UI, bridge, and extension commands require a separately trusted
`nir-production-runtime-policy-v1` envelope. The policy binds the canonical real path and SHA3-256
digest of the exact Node.js executable, its exact version, ABI build, platform and architecture,
the wallet/tool package hashes, and the complete network/genesis/release lineage. It also names the
permitted commands and has a bounded validity interval.

The runtime policy is not self-authorizing. It is approved by the configured threshold of the
existing release authority set. The supervisor must supply the independently retained exact policy
hash and sequence to every production command. A previous sequence or policy hash fails closed;
`previousPolicyHash` makes successive policies an explicit forward chain.

Offline ceremony:

1. On the target host, run `npm run wallet:runtime-policy -- inspect runtime.json`.
2. Prepare canonical `binding.json` with `networkId`, `genesisHash`, `releaseManifestHash`,
   `releaseVersion`, `sourceRevision`, `walletPackageHash`, and `toolPackageHash`; prepare a canonical
   JSON command array such as `["bridge","extension","ui"]`.
3. Run `npm run wallet:runtime-policy -- create runtime.json binding.json authority-set.json commands.json SEQUENCE PREVIOUS_POLICY_HASH_OR_none CREATED_AT EXPIRES_AT policy.json`.
4. Each authority independently runs `sign policy.json authority-set.json OPERATOR_ID VAULT approval.json`.
5. Assemble the threshold with `assemble policy.json authority-set.json envelope.json APPROVAL...`.
6. Verify offline with `verify envelope.json binding.json EXPECTED_POLICY_HASH SEQUENCE NOW COMMAND EXECUTABLE verified.json` and retain the expected hash and sequence outside the host.

Production UI, bridge, and extension command lines take `RUNTIME_POLICY EXPECTED_POLICY_HASH
POLICY_SEQUENCE` immediately after the tool anchor. They verify the runtime before opening a
listener or changing an extension generation. The UI repeats the check on each request; the bridge
rechecks before authorization and immediately before returning a password for signing; extension
operations recheck before and after their sensitive filesystem action.

Policy files are canonical, bounded, descriptor-read with no-follow semantics, and outputs use an
exclusive, inode-checked activation. Executable inspection resolves one canonical real path, opens
it with `O_NOFOLLOW`, hashes through the descriptor, and checks inode, size, and timestamps before
and after the read.

This narrows runtime substitution risk; it does not make the system Node.js binary, kernel, dynamic
loader, filesystem, or host administrator intrinsically trustworthy. OS code signing/notarization,
secure boot, protected storage for the external policy head, and independent operator custody remain
external production controls. Developer preview commands do not consume this policy and remain
separate from production launchers.
