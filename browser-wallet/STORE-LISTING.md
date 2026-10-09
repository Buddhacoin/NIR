# Draft Chrome Web Store listing — do not publish without review

Name: NIR Wallet (Test Preview)

Short description: Create and restore local NIR test addresses with a recovery phrase. No public network or real funds.

Single purpose: A local-only preview for creating, restoring, and viewing NIR test wallet addresses.

Full description:

NIR Wallet (Test Preview) lets you create a 24-word recovery phrase, set a local password, derive multiple NIR test addresses, and restore the same addresses on another device by entering the phrase. The phrase is encrypted in local browser extension storage. You can reveal it again in Settings after entering your password.

This version is only a wallet-interface and key-management preview. It cannot connect to a public NIR network, show spendable balances, send funds, mine NIR, connect to dapps, or automatically synchronize devices. No test balance is promised to become mainnet NIR. Never import a phrase that controls real funds.

Permissions justification:

- `storage`: retains the encrypted wallet profile and selected address locally between sessions. The extension has no host permissions or content scripts.

Privacy policy URL after the containing branch is merged: https://github.com/Buddhacoin/NIR/blob/main/browser-wallet/PRIVACY.md

Support contact: nir.blockchain@gmail.com

Before submitting: verify the store ZIP matches reviewed source, complete security review and full CI, capture a current screenshot of the actual preview UI with `npm run screenshot:store -- /absolute/output.png`, confirm listing and privacy disclosures, and publish only from the owner's registered developer account. Do not describe this build as a live payment wallet.
