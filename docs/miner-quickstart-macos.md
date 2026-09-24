# NIR mining on macOS: a beginner-safe quickstart

This guide starts from the point of view of a person who has a Mac and wants to
"mine NIR." Today that means trying a **local, valueless protocol demo**. There
is no official public NIR testnet, public faucet, mining pool, bootstrap peer,
job queue, or downloadable production miner. No command in this guide earns
tradeable NIR. If a site asks for money, a seed phrase, a wallet file, or a
"mining activation" payment, stop.

## What mining means here

NIR does not ask your Mac to guess hashes continuously. A future participant
will contribute or independently check measurable AI progress. The protocol
separates seven roles:

| Role | Plain-language job | Available today |
| --- | --- | --- |
| Capability author | Submit a better model, algorithm, or method | Simulated locally |
| Reproduction operator | Re-run assigned work independently | Specification only |
| Challenge author | Design fresh, objectively gradable tasks | Specification only |
| Safety evaluator | Run approved critical-risk checks | Specification only |
| Safety investigator | Report a new critical failure privately | Specification only |
| Fraud challenger | Prove an objective protocol violation | Specification only |
| Payment node | Store and check the ledger | Valueless localhost node |

For a first visit, choose **Capability author** to understand the mining flow,
or **Payment node** to explore the local ledger. Neither role earns real value.

## 1. Prepare the Mac

You need Terminal, Git, Node.js 26 or newer, and Python 3.11 or newer. Open
Terminal with Spotlight (`Command` + `Space`, type `Terminal`) and check:

```bash
git --version
node --version
python3 --version
```

The Node result must start with `v26` or a larger number. Install missing tools
from their official distributors, then close and reopen Terminal. Do not run a
script copied from an advertisement or direct message.

Obtain the source from the repository named by the project, enter its folder,
and make sure Terminal is at the repository root (the folder containing
`package.json`). If starting from the currently documented public source:

```bash
git clone https://github.com/Buddhacoin/NIR.git
cd NIR
```

No `npm install` is required for the current local demo.

## 2. Run the Mac preflight

The preflight is read-only. It recognizes the checkout, checks macOS, the CPU
architecture, Node version, required entrypoints, selected role, and—most
importantly—refuses to label anything as a public-testnet connection.

```bash
node blockchain/miner-macos-preflight-cli.mjs
```

Continue only if the first line says `READY`. For a local payment node instead:

```bash
node blockchain/miner-macos-preflight-cli.mjs --role payment-node
```

Machine-readable output is available with `--json`. This deliberately fails:

```bash
node blockchain/miner-macos-preflight-cli.mjs --mode public-testnet
```

The refusal is expected until the project publishes and supports a signed
network manifest. A URL pasted into a chat is not a substitute for that trust
root.

## 3. Try one simulated intelligence-mining round

```bash
npm run mine:demo
```

The script creates temporary in-memory participants, commits a candidate,
assigns a simulated evaluator committee, accepts signed evaluation evidence,
and places a simulated reward in the mandatory challenge-window escrow. Output
such as `height`, `issued`, available and pending balances, the unlock height, a
final block hash, and `ML-DSA-65` proves only
that the local rules executed. The wallets and balances vanish when the command
ends. Nothing was downloaded from a job service and nothing was submitted to a
public network.

To verify the code paths rather than trust one successful printout:

```bash
npm run test:python
npm run test:chain
```

These can take longer than the demo. A failed test means "stop and diagnose," not
"disable the check."

## 4. How an AI intelligence check works

The important distinction is between a useful demo score and a future
network-accepted proof:

1. A candidate first commits its exact artifact, canonical content digest,
   parent lineage, baseline, and hidden-suite commitment. Changing the artifact
   later changes the evidence.
2. The bond/admission must finalize before fresh randomness selects the complete
   evaluator committee. The candidate cannot choose friendly evaluators.
3. Independent evaluators run both the frozen baseline and candidate on the
   same hidden task families in a bounded environment.
4. The result measures capability gain, breadth across families,
   reproducibility, safety, and declared energy. One confirmed critical safety
   failure vetoes the progress reward.
5. Signed receipts bind the challenge, environment, artifacts, answers, and
   measurements into a reproducible bundle. Validators check the protocol
   evidence; they do not simply trust an AI's claim that it is intelligent.
6. Duplicate accepted canonical content or an already-recorded frontier delta
   cannot receive the same reward again. This detects exact committed content,
   not every semantically copied idea.
7. An accepted claim remains pending through an objective fraud window. Only
   after it closes can the future reward and bond unlock.

Current example JSON files are static answers used to exercise these rules.
They do not execute ChatGPT, Ollama, MLX, a Python training program, or another
AI application, and a high example score is not a production intelligence
certificate.

## 5. Connecting a model or AI application

There is no general "Connect app" button or supported connector today. The
safe future boundary should look like this:

1. The desktop miner lists supported local adapters and their exact permissions.
2. The user selects an artifact folder or a localhost-only adapter; the miner
   shows which files and endpoints it can read. Cloud APIs are opt-in and their
   projected fees are shown before approval.
3. Model weights, API keys, prompts, and hidden test data stay out of the wallet,
   browser page, logs, and on-chain transaction. Secrets belong in the OS
   keychain or an isolated runner, not in command arguments.
4. A signed container has no arbitrary host shell or network access. The user
   sees CPU/GPU, memory, disk, estimated duration, energy, API cost, bond, and
   maximum loss before pressing **Run test**.
5. A practice check uses public sample tasks. A real assignment starts only
   after the on-chain commitment finalizes; hidden tasks are revealed only to
   assigned evaluators.
6. The app displays a receipt hash and status, while the private model remains
   local unless the user explicitly chooses a reviewed remote evaluator path.

Until such adapters, containers, permissions, and signed releases exist, do not
give an unofficial NIR website access to a local model server or cloud API key.

## 6. Create a separate practice wallet (optional)

The mining demo does not use or fund your wallet. A wallet is useful only for
learning the future identity and approval flow. Choose a private path outside
the repository; the file must not already exist:

```bash
mkdir -p "$HOME/Documents/NIR-Practice"
npm run wallet:create -- "$HOME/Documents/NIR-Practice/practice.nirvault.json"
npm run wallet:address -- "$HOME/Documents/NIR-Practice/practice.nirvault.json"
```

The password prompt is hidden. Use at least six unrelated words and store an
offline recovery copy. Never paste the password or vault contents into chat,
a browser form, an environment variable, or a command argument. The displayed
`nir1...` address is public; the vault file and password are not.

## 7. Explore the local node and wallet UI (optional)

This is a localhost development network, not the public testnet. Use a new data
folder:

```bash
npm run node:init-dev -- "$HOME/Documents/NIR-Practice/local-node"
npm run node:serve -- "$HOME/Documents/NIR-Practice/local-node"
```

Keep that Terminal window open. The node prints that it listens on
`http://127.0.0.1:8787`. It rejects public bind addresses. Its
`DEVNET-KEYS.json` contains unencrypted test keys: never reuse or publish them.

In a second Terminal, start the signing bridge with the practice vault and the
local genesis trust anchor:

```bash
cd NIR
npm run wallet:bridge -- \
  "$HOME/Documents/NIR-Practice/practice.nirvault.json" \
  8788 http://127.0.0.1:8765 \
  "$HOME/Documents/NIR-Practice/local-node/genesis.json"
```

The bridge prints an eight-digit, two-minute pairing code. It binds only to
localhost. Keep it open: every signature still needs `SIGN` plus the vault
password in Terminal.

In a third Terminal:

```bash
cd NIR
npm run wallet:preview
```

Open `http://127.0.0.1:8765`, pair with the one-time code, and verify that the
public address matches the address printed earlier. The local node has a
developer faucet RPC, but the current UI has no faucet button; a new wallet
therefore remains empty unless a developer funds it separately. The UI can show
local status, and signing and submission are separate actions. Read the complete
terminal summary before approving anything. Close the bridge when finished.

## 8. Status and practice reward

The current one-command demo jumps through the simulated lifecycle and prints
the resulting balances. The future application must instead keep an auditable
timeline:

`Draft → Preflight → Awaiting approval → Committed → Assigned → Running → Pending review → Challenged or accepted → Fraud window → Test reward unlocked`

Every state needs a plain-language reason, block/receipt link, next action,
deadline, and worst-case bond outcome. "Pending" is not a promise. "Rejected"
must say whether the cause was no gain, safety failure, irreproducibility,
duplicate content, timeout, invalid evidence, or a local/network error.

A future faucet and test reward must always be labelled **TEST NIR — no monetary
value** in the title, balance, confirmation sheet, notifications, and export.
There is no test reward to claim from a public service today.

## 9. What the finished desktop journey should feel like

One signed macOS application should guide a newcomer through these screens:

1. **Welcome:** Local practice or an authenticated network from a signed
   manifest; never a free-form peer URL presented as official.
2. **Mac check:** Apple/Intel chip, OS, disk, memory, thermal/power guidance,
   sandbox support, expected download, duration, energy, and cloud/API cost.
3. **Wallet:** Create, import, or watch-only; recovery check before any bond;
   mining and everyday spending keys visibly separated.
4. **Role:** Requirements, permissions, bond, maximum loss, expected work, and
   whether that role is open. Unsupported roles remain disabled with a reason.
5. **Model/app:** Local file or explicitly supported adapter, least-privilege
   permission review, connectivity test, and a public-sample dry run.
6. **Job review:** Baseline, task-family commitment, signed container, assigned
   role, resource ceiling, privacy boundary, payout rule, and cancel deadline.
7. **Explicit approval:** A native confirmation—not a website—authorizes the
   exact commitment and maximum spend. No background auto-bonding.
8. **Run:** Progress, temperatures/resource use, logs scrubbed of secrets,
   pause/cancel behavior, and automatic signed receipt verification.
9. **Result:** Capability, breadth, reproducibility, safety, energy, independent
   evaluator agreement, receipt hash, and a human-readable rejection reason.
10. **Reward:** Pending/challenge-window/unlocked states, test-value label,
    bond return or loss, and exportable evidence. No income estimate.
11. **Health:** Network/genesis fingerprint, verified release and update,
    synchronization, last assignment, disk use, backup age, and one-click
    diagnostics that exclude secrets.
12. **Remove:** Stop jobs, wait for or explicitly abandon active obligations,
    export receipts, remove application/cache, and separately choose whether to
    retain or delete the encrypted wallet.

Notifications must never say "you earned" before finalization. Automatic
updates, new network manifests, larger resource limits, and new application
permissions each require a review screen.

## 10. Diagnose problems

Run the preflight again first:

```bash
node blockchain/miner-macos-preflight-cli.mjs --json
```

- `Node.js 26+ is required`: install a supported Node release and reopen
  Terminal.
- `NIR source checkout recognized` fails: `cd` to the folder containing this
  repository's `package.json`; do not bypass the identity check.
- `EADDRINUSE` or listener unavailable: another process owns the local port.
  Close the older NIR process; do not change the host to `0.0.0.0`.
- wallet creation says the destination exists: choose a new filename. The
  command refuses to overwrite a vault.
- pairing fails: restart the bridge to obtain a new code, confirm the exact
  `http://127.0.0.1:8765` origin, and pair within two minutes.
- a test or proof check fails: preserve the output, stop signing/submitting,
  and compare the checkout with a trusted release. Do not edit evidence files
  until a copy is saved.

Diagnostic reports should contain versions, public hashes, state names, and
bounded logs—never passwords, private keys, session tokens, API keys, model
secrets, or hidden task contents.

## 11. Stop or remove the practice setup

Press `Control-C` in the bridge, wallet-preview, and node terminals. Confirm
that ports 8765, 8787, and 8788 are no longer in use if desired:

```bash
lsof -nP -iTCP:8765 -iTCP:8787 -iTCP:8788 -sTCP:LISTEN
```

The source checkout, `NIR-Practice/local-node`, and the wallet are separate.
Deleting the checkout does not delete the wallet or node data. Before removing
anything, decide separately whether to retain:

- the encrypted `practice.nirvault.json` and its recovery copy;
- the non-secret `.trust.json`, `.headers.json`, and `.handoffs.json` files that
  may appear beside a bridge-connected vault;
- exported receipts or test evidence;
- the valueless local-node folder, including its unsafe development keys.

Use Finder's Trash for folders you intentionally remove so the action is
recoverable. A future uninstaller must never delete a wallet by default and
must refuse removal while a bonded job or challenge deadline is active.

For the protocol details and security limitations, continue with
[`mining.md`](mining.md), [`wallet.md`](wallet.md), and [`node.md`](node.md).
