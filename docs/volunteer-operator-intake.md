# Volunteer Operator Expressions of Interest

NIR is collecting **expressions of interest** from people who may help run a
future, valueless developer-testnet rehearsal. This is not approval to start a
service or an announcement that a public network is live. Test units have no
represented monetary value, and participation carries no promised pay or
reimbursement. The maintainer will review responses manually and contact
candidates before sharing any deployment instructions or network commitment.

To express interest, email [nir.blockchain@gmail.com](mailto:nir.blockchain@gmail.com)
with the short template below. Use the subject `NIR volunteer operator interest`.
This address is for operator coordination, **not** for private keys, passwords,
recovery phrases, identity documents, or vulnerability details. Report security
issues through [private vulnerability reporting](../SECURITY.md) instead.

Read the [participation overview](participation.md) and the
[canonical Gate matrix](public-testnet-gates.md) before considering a role.
The initial cohort needs four independently administered validators, at least
four beacon operators with separate keys and failure domains, and at least
two archive operators with independently administered backups and isolated
restore drills. Distinct keys, endpoints, or machines alone do not establish
independent control; human reviewers must assess shared administration,
hosting, and conflicts before counting an operator toward a gate.

An operator should be able to administer a dedicated or safely isolated host,
maintain stable connectivity and system updates, run Node.js 26+, monitor the
service, keep encrypted offline backups, attend a scheduled rehearsal and
respond to incidents. Operators create and retain their own keys and
credentials. Role-specific procedures are in the
[validator ceremony](validator-ceremony-onboarding.md),
[validator deployment](validator-deployment.md),
[beacon operations](beacon.md), and
[backup and restore drills](backup-recovery-drills.md) guides.

Never put a vault, seed, private key, password, recovery phrase, remote-access
credential, personal contact details, or other personally identifying
information in a public issue, pull request, or reply. Do not post private
host or network details publicly. Do not email secrets to the maintainer either.
No role is approved by sending this template. Public operator fields such as
identity, endpoint, public key, or certificate fingerprint may be published
only after review and the operator's explicit consent to the specific fields.

## Short private intake template

Send only to the contact above. Do not attach keys, credentials, vaults,
identity documents, or host configuration files.

- Preferred role: [validator / beacon / archive]
- Can you administer your own host, account, and role keys? [yes / no / discuss privately]
- Any shared control, role conflict, or common failure domain to disclose? [discuss privately]
- Host readiness (isolation, updates, connectivity, Node.js 26+, monitoring): [summary]
- Backup and isolated restore-drill capability: [summary]
- Availability for a scheduled rehearsal and incident response: [summary]
- Constraints or questions for the manual reviewer: [summary]
- Consent to publication of any specific public operator fields: [not requested yet; decide only after field-by-field review]
