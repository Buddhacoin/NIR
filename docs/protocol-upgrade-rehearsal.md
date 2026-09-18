# Local protocol-upgrade rehearsal

`blockchain/protocol-upgrade-rehearsal.mjs` is a deterministic local drill for
the delayed protocol-version state machine. It starts four validator child
processes with separate keys, journals and data directories. The controller is
a fifth process. This exercises process isolation and quorum behavior on one
host; it is not evidence of independent organizations, machines or network
failure domains.

## Run

Choose a path that does not exist and four consecutive unused loopback ports:

```sh
node blockchain/protocol-upgrade-rehearsal.mjs \
  /tmp/nir-protocol-upgrade-rehearsal 18791
```

The script exits nonzero on the first failed assertion and always stops the
validator processes. On success it prints a JSON report and writes the same
report to `rehearsal-report.json` in the drill directory. Preserve that file
with the tested source revision when using it as operator evidence.

The drill proves all of the following against the normal validator HTTP and
authenticated peer-request path:

- four separate validators finalize a version-25 schedule with the required
  notice interval;
- an internally consistent, signed version-25 proposal before activation is
  rejected specifically by the activation-height rule;
- version-24 validation remains compatible through the last pre-activation
  block and fails closed on the activation block;
- one stopped validator restarts from its own older journal and catches up
  across activation;
- a direct downgrade schedule is rejected;
- recovery is represented only by a new quorum-finalized forward schedule,
  while the finalized activation history remains unchanged; and
- restarting the controller preserves the active version and pending schedule.

## Bounded rollback claim

The repository currently implements execution through protocol version 25.
The rehearsal schedules version 26 as the forward recovery action but does not
activate it: version-26 execution rules do not yet exist, so the current binary
must stop before that activation height. Therefore this is evidence for the
forward-only recovery control plane and immutable history, not evidence that a
semantic rollback release has been implemented or executed.

Before a production upgrade, repeat the exercise with the actual new and
recovery binaries on independently administered hosts, add network partitions
and delayed delivery, retain signed artifacts, and verify application-specific
state transitions on both sides of activation.
