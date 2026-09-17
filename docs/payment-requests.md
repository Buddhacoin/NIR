# Signed NIR payment requests

A signed payment request lets a recipient specify one exact payment without
giving a website or messenger authority over the payer's wallet. Version 1
binds all of these fields with the recipient's post-quantum account key:

- recipient address and public key;
- atomic NIR amount;
- NIR network identifier;
- unique 256-bit request identifier;
- expiration time;
- optional memo of at most 160 UTF-8 bytes;
- format and signature-algorithm versions.

Unknown fields are rejected. A request also fails if any bound value changes,
its address does not match its public key, its network differs from the payer's
connected network, or its expiry has passed.

## Create a request in the local wallet

1. Connect the encrypted vault and local valueless node.
2. Choose **Receive**.
3. Enter the exact amount, an optional memo and a validity period from one
   minute to thirty days.
4. Confirm the action and enter the vault password only in the bridge terminal.
5. Copy the resulting JSON and deliver it to the intended payer through any
   channel.

The JSON contains a public key and a signature, so it is intentionally larger
than a plain address. It contains no password or private key.

## Pay a request

1. Open **Send** and expand **Paste signed payment request**.
2. Paste the complete JSON and choose **Verify and fill**.
3. The local bridge verifies the signature, expiry and exact connected network.
4. Only a verified request can fill the recipient and amount fields.
5. Review the normal fee screen, request a separate transaction signature and
   use the separate test-network submit button.

The payment request is not money and does not reserve funds. Final payment
still follows normal balance, nonce, fee and consensus rules. Reusing a request
does not bypass transaction replay protection, although merchants should treat
the unique request identifier as an invoice identifier and reject duplicate
settlement in their own order system.
