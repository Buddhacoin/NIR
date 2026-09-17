# NIR wallet production audit

Date: 2026-09-17

## Result

This pass closes four concrete pre-production gaps without changing consensus:

1. An installed wallet directory can be reverified after installation against
   the trusted post-quantum release signature. Verification rejects a changed,
   missing, additional, executable-mode-changed, symbolic-link or provenance
   file.
2. A personal encrypted vault can be decrypted for an integrity check, copied
   to a new private backup file, and restored only into another new private
   file. Backup and restore re-open and decrypt the written copy before success
   is reported.
3. The browser bridge now has an authenticated session-revocation endpoint.
   Disconnecting in the interface revokes the bridge session and erases the
   token, pending intents and signed payloads held by the page.
4. The interface now has a first-run path, explicit creation/backup/verify/
   restore instructions, security status, accessible live regions, reduced
   motion and forced-colour handling, and narrow-mobile/desktop breakpoints.

The browser extension still requests no general browser permission. It requests
only loopback host access, which is required to reach the local signing bridge
and locally configured development nodes. Both the web page and extension have
an explicit content security policy that blocks remote scripts, embedded
objects, frames and form submission.

## User workflow

Create a new encrypted vault:

```bash
npm run wallet:create -- /absolute/private/path/personal.nirvault.json
```

Verify that its password and authenticated encryption are valid:

```bash
npm run wallet:verify -- /absolute/private/path/personal.nirvault.json
```

Create a verified backup on another mounted device or private directory:

```bash
npm run wallet:backup -- \
  /absolute/private/path/personal.nirvault.json \
  /another/private/location/personal-backup.nirvault.json
```

Restore a backup into a new path:

```bash
npm run wallet:restore -- \
  /another/private/location/personal-backup.nirvault.json \
  /absolute/new/path/personal.nirvault.json
```

All four commands read passwords interactively. Passwords are never accepted in
arguments or environment variables. Backup files contain an encrypted private
key and must still be treated as sensitive.

After installing a signed wallet package, verify the installed directory at any
time:

```bash
npm run release:verify-wallet-install -- \
  /absolute/path/to/installed-wallet \
  signed-release.json \
  nir1TRUSTED_RELEASE_ADDRESS
```

## Threats checked in this pass

- tampered installed HTML, JavaScript, CSS or manifest;
- extra executable or hidden file in the installed wallet directory;
- substituted installation provenance;
- untrusted release signer;
- wrong vault password or modified ciphertext;
- overwrite of an existing vault or backup;
- permissive vault file mode or symbolic-link source;
- browser session remaining authorized after explicit disconnect;
- remote script execution through wallet page policy;
- unusable motion, contrast-mode and narrow-screen states.

## Remaining launch gates

This is not yet a real-value production wallet. The following remain mandatory:

- independent security review of the bridge, release pipeline and complete UI;
- signed native installers with platform signing/notarization and reproducible
  verification where the platform permits it;
- hardware-backed key support and a reviewed consumer recovery design;
- transaction simulation and human-readable decoding for every operation type;
- phishing-resistant address book and large-address comparison flow;
- public multi-node operation, incident drills and update-key rotation drills;
- end-to-end accessibility testing with screen readers and keyboard-only users;
- store review of the deliberately narrow loopback host permission.

No test or local audit can establish that the wallet is impossible to exploit.
The correct production gate remains independent review plus operation on a
public test network before any real-value activation.
