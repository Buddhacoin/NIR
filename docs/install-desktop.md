# NIR on Linux and Windows

```bash
curl -fsSL https://nircoin.com/install.sh | bash
```

On Linux the same command as on a Mac installs **NIR**: NIR Wallet and NIR
Майнер in one app (`blockchain/nir-desktop.mjs`). Windows uses the same app;
its installer is described below once it ships.

## What the Linux installer does

Only what is missing, for the current user, without root except to install
git through the system's package manager:

1. git, through apt, dnf, pacman or zypper (asks for the password);
2. Node.js (the version pinned in the script), checked against the SHA-256
   sums nodejs.org publishes;
3. a shallow clone of this repository into `~/.local/share/nir/source`, the
   `nir` command in `~/.local/bin` and a menu entry
   (`~/.local/share/applications/nir.desktop`).

Running the script again updates the source. Python is not needed: mining on
the shared network is pure JavaScript, and NIR Майнер's optional model checks
report that Python is missing.

## How the app works

`nir-desktop.mjs` runs the same local services as the Mac apps — the miner
(`mining-practice-app.mjs`), the wallet bridge on `127.0.0.1:8788` and the
wallet page — and shows the pages in **app windows** of a Chromium-family
browser (Edge, Chrome, Chromium, Brave or Vivaldi; `NIR_BROWSER` picks one).
Every window opens in NIR's own private profile (`~/.local/share/nir/window`):
no extensions, no history or passwords shared with everyday browsing. Without
such a browser the pages open in the default browser instead.

What a Mac shows in system windows — the 24 words, the wallet password, the
confirmation of every signature — appears in NIR's **confirmation windows**
(`desktop-dialogs.mjs`, `desktop-ui/`). They are served from a separate
loopback origin; each window gets a one-time token in its URL fragment, so the
wallet page never receives a password or the words. A closed window counts as
a refusal.

- **First start:** create a wallet (password, the 24 words, two of them asked
  back) or restore one from 24 words. Later starts open the existing wallet.
- **Signatures:** the confirmation window shows what is signed and asks for
  the password; the bridge never takes a password from the page.
- **Settings:** show the 24 words again, change the password, add an account.
  Renewing the older recovery codes and the founder share are Mac-only.
- **Closing:** the services stop when the last NIR window closes. Starting NIR
  again while it runs reopens both windows; the wallet window pairs with a new
  one-time code and the previous page's session ends.

## Files

| | Linux | Windows |
|---|---|---|
| Wallet | `~/.local/share/nir/wallet` | `%LOCALAPPDATA%\NIR\Wallet` |
| Miner | `~/.local/share/nir/miner` | `%LOCALAPPDATA%\NIR\Miner` |
| Window profile | `~/.local/share/nir/window` | `%LOCALAPPDATA%\NIR\Window` |

`XDG_DATA_HOME` moves the Linux folders. The wallet folder holds the same
encrypted files as on a Mac, so the 24 words restore the same accounts on any
system.
