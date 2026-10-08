# Open NIR Wallet testing

## Status and access

No invitation, whitelist, purchase, or manual account approval is required to
inspect the published browser preview or send usability feedback. A Mac desktop
prototype exists in the development checkout, but its source package and
public installer have **not** been published here; people cannot download that
Mac app from GitHub yet. There is no shared NIR testnet. Testing a local copy
does not create real-value NIR or reserve a mainnet balance. Do not use funds
or keys from another wallet.

The eventual public developer testnet should be self-service for ordinary
wallet users: verify the official release, create keys on their own device,
connect to the published network, receive rate-limited test units, follow a
short set of tasks, and report what happened. No human should need to approve
each user. Publishing that path waits on the
[public-testnet launch gates](public-testnet-gates.md); this document does not
announce a network or download that does not exist.

Validator, beacon, and archive operators are different: their independent
control and host readiness must be reviewed before their evidence counts
toward launch. This is not permission to own or test an ordinary wallet.

## What to test and how results are counted

The first public checklist should cover installation and update, account
creation, backup, close/reopen, restore on a fresh profile, pairing, receiving
test units, sending, fee review, a failed/offline node, and recovery after an
interrupted operation. Each published scenario needs a release/network ID,
expected result, safe exit, and a way to report a failure. Until the shared
testnet opens, reports must explicitly say **local browser preview** or
**development Mac prototype**, as applicable.

Use the [wallet feedback issue form](https://github.com/Buddhacoin/NIR/issues/new?template=wallet-local-feedback.yml)
for non-sensitive bugs or confusing steps. Search existing reports first.
Include the scenario, app/source version, device/OS, exact reproduction steps,
expected and actual behavior, and a redacted screenshot or log only if needed.
Never post a password, pairing/recovery code, private key, vault or backup file,
personal data, or a full exploit. Report security flaws privately through
[SECURITY.md](../SECURITY.md), not a public issue.

Maintainers should maintain a public issue-based ledger by scenario and
release: attempted/completed tasks, reproducible failures, severity, duplicate
decision, fix revision, retest result, and unresolved blockers. Counts of
downloads, addresses, clicks, or test balances are **not** proof of readiness.
No hidden telemetry is required: any future diagnostics must be opt-in and
exclude secrets by design.

## Launch decisions and rewards

Before a public developer testnet is announced, its gate matrix must pass on
independently controlled hosts; the wallet's supported first-use and recovery
paths must be reproducible; and critical security/key-loss defects must be
resolved. Public testnet success alone does not authorize a real-value mainnet
or exchange market. Those require the separate audits, sustained operation,
genesis review, and legal decisions in [launch-readiness.md](launch-readiness.md).

Testing is not automatically paid. Test balances never convert one-for-one to
mainnet NIR. The draft [tester reward policy](tester-rewards.md) describes a
possible capped program, but it is not active until terms, funding, reviewers,
and a public announcement are in place. A bug report creates no payment claim.
