# Operations and recovery

## Availability and lifecycle

`GET /healthz` checks D1 availability and returns only status/build version. `GET /readyz` also validates the public HTTPS origin and active encryption key. Neither exposes credentials, panel names, tenant data or account/database identifiers. Customer bot execution reads that customer's encrypted token, not the factory token; failure of the factory Telegram account does not erase registrations or prevent ordinary customer operation.

Webhook receipt persists an encrypted inbox record before returning 200. Background processing is opportunistic; the minute cron is the recovery mechanism. Commands run only for active customer bots. Repeated Telegram update IDs cannot create another inbox record. Ignored updates are completed without a reply. Owner/customer responses go through an encrypted durable outbox.

Service operation lifecycle:

- `PENDING → PROCESSING → SUCCEEDED` only after the target panel confirms expected state.
- Temporary/authentication/configuration/unconfirmed network results become `UNKNOWN` with bounded backoff (at most five automatic attempts).
- Permanent identity conflicts/missing services become `FAILED`; permanent CREATE and paid renewal failures mark the appropriate order failed; its approved payment is retained.
- Expired processing leases are recoverable after 120 seconds. Adapter network calls are bounded to eight seconds each.
- UNKNOWN/FAILED operations are visible in `/errors` or `/report`. Admin `/retry OPERATION_ID` resets bounded attempts and reconciles remote state before mutation. Fix configuration/identity conflicts before retrying.

CREATE uses a preallocated UUID and stable email. Before any repeated creation, it reads the actual selected inbound. Matching remote identity/parameters mean success without another creation. Conflicting identity is a hard failure. Renewals use absolute stored target limits/expiry, not an increment calculated on each retry. Revoke verifies absence. No route ever falls back to a different panel.

Panel state is authoritative for live usage/expiry: `/service ID` queries it. Local recorded expiry notifications explicitly describe recorded validity, not fabricated remote traffic. CREATE validity is anchored after authoritative remote absence immediately before creation; uncertain successful creation retains its persisted target rather than extending on every retry. Set prices deliberately: a zero-priced active plan is a real free offering.

## Incidents

- **Panel timeout/HTTP error:** inspect the panel itself, HTTPS hostname/path, credentials, compatible release and `/panel_test ID`. Do not switch the service's panel ID. Repair then `/retry` its operation.
- **Ambiguous creation:** never manually issue a second creation with a new UUID. Inspect the stable client ID/email first; use reconciliation.
- **Telegram invalid token:** revoke/replace the token through BotFather, then register the replacement as the same recorded owner and repair the webhook. Existing bot identity stays bound to the original owner. Deletion with an invalid token may remain DELETING; an operator must detach/recover safely rather than pretend detachment succeeded.
- **Factory account unavailable:** customer bots continue. Restore the factory token and webhook through bootstrap using the same D1 database, key ring and intended IDs.
- **Lost central access:** an authorized Cloudflare account operator updates `CENTRAL_ADMIN_IDS` to a verified replacement numeric ID and repairs factory access. Do not rely on a username or reset tenants.
- **Lost master key:** restore the protected recovery copy. Without it, ciphertext cannot be decrypted. Bot/panel credentials must be reissued and deliberately re-registered; do not claim cryptographic recovery.
- **Dead reply:** `/errors` includes redacted delivery codes. A ambiguous `sendMessage` retry may duplicate a notification; it does not duplicate the operation or mark payment paid. There is no exactly-once Telegram-send guarantee.

## Deployment failure and rollback

CI stops on failed checks. Secret-name checks happen before remote migrations. Migration/deploy failures are nonzero and never trigger table drops or automatic resets. A migration can succeed while the Worker deployment fails; the previous Worker then continues against the forward-migrated schema. Keep migrations backward-compatible and retain a tested D1 recovery/export procedure.

No automatic rollback is implemented or claimed. Inspect deployed Worker versions with official Wrangler tooling. Re-deploy a reviewed prior compatible source version after checking schema compatibility. Do not revert database migrations blindly. The post-deploy check verifies the exact build identifier; a healthy old deployment cannot accidentally pass as the new version.

## Capacity

Each webhook/cron pump handles one inbox record, one service operation and at most two outbound messages. This deliberately bounds network/subrequest use, not an arbitrary number of registered bots/panels. D1/Worker CPU, storage, row-write and request quotas still apply. Cron recovery alone is low-throughput; higher traffic requires load testing and justified tuning, and may require a paid plan or queue-based design. No paid feature was enabled, and free-plan suitability is not claimed for an unknown workload.

Use operator-controlled alerts for failed deployments, UNKNOWN operations and queue age. The repository supplies diagnostics but does not create an external monitoring subscription or promise unattended incident resolution.

## Manual commerce recovery

Keep payment_state separate from order/service state. UNDER_REVIEW is unpaid; APPROVED means recorded manual approval, not a provisioned service. Approval schedules durable work atomically. A paid FAILED/UNKNOWN operation must be repaired/retried on its original panel, never require another transfer or create a second client. Paid renewals have their own operation.order_id; fulfilment updates that renewal order, not the original purchase.

Paid renewal reconciles the remote original quota/expiry or already-applied desired targets. Unexpected external changes become REMOTE_STATE_CHANGED; resolve the discrepancy deliberately before retry. Unlimited imported services are not converted to finite quotas by customer renewal. Exhausted PROCESSING claims are recovered to UNKNOWN/DEAD instead of being stranded. Old workers cannot finalize another worker's claim. Telegram sends still cannot be exactly-once.

## Backup and restore rehearsal

Only an explicitly authorized operator should run remote commands. Before upgrades, export D1 with the official CLI to encrypted offline storage:

```sh
npx --no-install wrangler d1 export DB --remote --output /secure/offline/errf-backup.sql --config wrangler.production.json
```

Store MASTER_KEYS separately with restricted recovery access. The export contains sensitive ciphertext, operational records and review metadata; do not place it in GitHub/artifacts or this source ZIP. Test restoration to a separate authorized non-production D1 database with current official import tooling, matching key ring and all migrations; verify integrity/foreign keys, row counts and decryption. Do not restore over production without explicit approval and a reconciliation plan for remote clients/payment decisions made after the backup. Replaying old inbox/operations can conflict with current panel state; use the existing stable identities and manual reconciliation. No automated backup schedule or tested live restore is claimed.

Financial reference retention is currently fixed at 90 days for terminal orders and runs during hourly cron maintenance. Pending paid/review obligations are not purged. Changing this policy requires a reviewed code/configuration extension; no runtime retention setting currently exists. Validate legal/privacy requirements. Retention does not remove Telegram-hosted files or historic backups.
