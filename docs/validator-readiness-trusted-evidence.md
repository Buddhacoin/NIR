# Readiness launch evidence

The three-process readiness launcher now requires two separate inputs: the child bootstraps and
operator-retained trust evidence. A bootstrap hash or pin copied from a child package is an integrity
check, not evidence that an operator approved that package.

The trust evidence contains the short-lived readiness session, the complete signed source release,
the locally trusted release-signer address, and a local policy. The policy pins the exact release
manifest hash, network and genesis identity, checkpoint witness policy, exact checkpoint
height/hash, admission ID and candidate address, public HTTPS endpoint, local bound host/port,
TLS certificate fingerprint, and fresh launcher nonce. The launcher verifies the release signature
against the separately trusted
address, reconstructs the release provenance, verifies the session's checkpoint trust package and
bindings, checks every policy field, verifies the three bootstraps against that session, and only
then derives pins. The supplied pin set must match those derived pins exactly. Missing evidence,
wrong signatures, stale sessions, mismatched checkpoints, changed endpoints, and substituted
bootstrap cohorts fail before child processes start.

The policy and release-signer address must come from independently controlled operator state, not
from the candidate's child package or from the same untrusted JSON file. This module verifies the
signature on the release manifest but does **not** verify the installed executable files against
that manifest; installation/release verification is a separate required gate. A signed checkpoint
package also does not establish that a remote operator or witness is organizationally independent.
There is still no public operator CLI or production socket-activation service in this layer.
