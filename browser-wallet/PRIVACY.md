# NIR Wallet browser preview — privacy notice

This notice applies only to the NIR Wallet browser-extension preview version 0.1.0. It is not a notice for a future network-connected wallet.

The extension creates or accepts a 24-word recovery phrase, derives NIR test addresses on your device, and encrypts the phrase with the password you choose. The encrypted wallet profile, address count, and selected address are stored in the browser's local extension storage. The phrase and password are processed on your device; the extension does not send them to NIR servers or third parties. This preview has no analytics, advertising, remote account, cloud sync, or network transaction feature. It does not request access to websites you visit.

The `storage` permission is used only to keep the encrypted wallet profile and local address preferences between browser sessions. The extension does not read other extensions' storage. If you choose “Copy” for an address or recovery phrase, that value is put on your device's clipboard at your request; other software with clipboard access may be able to read it.

You can delete local extension data by removing the extension or clearing its storage. Back up the recovery phrase offline before doing so: we cannot retrieve or reset it. The browser or operating system may separately back up your browser profile under its own settings and policies.

This is experimental software for local testing only. Do not import a recovery phrase that controls real funds. It has no public NIR network connection, balance, transfers, mining rewards, or dapp access. If its data practices change in a future version, this notice and the in-product disclosures must be updated before release.

Questions: nir.blockchain@gmail.com. Source code: https://github.com/Buddhacoin/NIR/tree/main/browser-wallet.
