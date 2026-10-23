# Installing NIR on a Mac

```bash
curl -fsSL https://nircoin.com/install.sh | bash
```

`site/install.sh` builds NIR Wallet and NIR Майнер on the user's own Mac from
this repository. Apps built on the Mac they run on need no Apple developer
signature, so there is no paid Apple account and no "unidentified developer"
warning. The script installs only what is missing:

1. Apple's Command Line Tools (git, clang), through Apple's own install window;
2. Node.js (the version pinned in the script), checked against the SHA-256
   sums nodejs.org publishes;
3. Python 3.11 or newer for NIR Майнер's model checks. An existing Python is
   reused; otherwise python.org's installer is used only if
   `pkgutil --check-signature` names the Python Software Foundation, and it
   asks for the Mac password once;
4. the source (a shallow clone into `~/Library/Application Support/NIR Install`)
   and both apps, into `/Applications` or, if that is not writable,
   `~/Applications`.

Apps that already exist are left alone: they update themselves from
**Settings → Check for updates** ([`app-updates.md`](app-updates.md)). Running
the script again is safe. It sends nothing anywhere and touches no wallet: keys
are made later inside NIR Wallet.

## The website

`site/` is the static nircoin.com page. `deploy/install-shared-testnet.sh`
serves it when given a second domain:

```bash
curl -fsSL https://raw.githubusercontent.com/Buddhacoin/NIR/main/deploy/install-shared-testnet.sh \
  | bash -s -- testnet.nircoin.com nircoin.com
```

Caddy serves `site/` for `nircoin.com` and `www.nircoin.com` and passes
`/api/*` to the test network's read API, which the page uses for its live
numbers. Point both names' DNS A records at the server first.
