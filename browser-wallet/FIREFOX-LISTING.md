# Firefox Add-ons submission draft — experimental preview

This is a draft for the owner of the Mozilla publisher account. Do not submit it as a live wallet or promise that test balances have value.

Name: NIR Wallet (Test Preview)

Summary: Create and restore local NIR test addresses using a 24-word recovery phrase. No public network or real funds.

Description:

NIR Wallet (Test Preview) is an experimental browser wallet interface for local testing. Create a 24-word recovery phrase, protect it with a local password, derive multiple NIR test addresses, and restore the same addresses in another Firefox installation by entering the phrase. The phrase can be viewed again from Settings after entering the password.

The phrase is encrypted in Firefox extension storage. This version cannot connect to a public NIR network, display a spendable balance, send or receive live funds, mine NIR, connect to websites, or synchronize devices automatically. Do not import a phrase that controls real funds. An offline copy of the phrase is required for recovery if the browser profile is lost.

Publisher choices:

- Distribution: listed on addons.mozilla.org, marked experimental.
- Compatible platform: Firefox desktop only; Android support is not declared or tested.
- Payment or external service required: no.
- `storage` permission: saves the encrypted wallet profile and selected address locally. No host permissions or content scripts.
- Data collection: none. No analytics or remote wallet service in this build.
- Privacy policy: `https://github.com/Buddhacoin/NIR/blob/main/browser-wallet/PRIVACY.md` **only after this file is merged to `main`**.
- Support: nir.blockchain@gmail.com.
- Source: `https://github.com/Buddhacoin/NIR/tree/main/browser-wallet` **only after merge**. Since the extension is bundled with esbuild, provide Mozilla reviewers with the full source archive and build instructions (`npm ci && npm run package:firefox` from `browser-wallet/`). Include `blockchain/bip39-english.txt` and `wallet-ui/nir-coin-icon.png` from the same Git revision.
- Third-party library source: `https://github.com/paulmillr/noble-hashes` and `https://github.com/paulmillr/noble-post-quantum` (exact versions are pinned in `package-lock.json`).

The artifact from `npm run package:firefox` is an **unsigned submission candidate**, not a user-facing installer. Upload that exact ZIP and the accompanying source archive to Mozilla Add-on Developer Hub after comparing their SHA-256 values with the provenance JSON from a reviewed, passing CI run. Run `npm run test:release` to rebuild from the extracted reviewer source archive and compare exact ZIP bytes. Reviewers can run `npm ci`, then `node scripts/package-firefox.mjs --rebuild-from-source` in its `browser-wallet` directory; the script always rebuilds ignored output before packaging. The JSON is not a Mozilla signature. Only after Mozilla signs/publishes the listed add-on should README point ordinary users to its actual AMO page. Never provide an unsigned ZIP as a one-click download for release Firefox.
