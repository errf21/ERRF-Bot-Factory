# Security model and boundaries

## Tenant authorization

Every customer entity is bot-scoped; bots belong to tenants. Every owner command requires a membership joined through that exact bot. Only the primary tenant owner grants/revokes tenant administrators. Central commands require explicit numeric IDs in the bootstrap secret or centrally granted admin records. Only bootstrap admins change central admins. Customers can read only their own services/orders. Private message chat IDs must equal the authenticated Telegram sender ID; group management is rejected.

A registered token proves bot control, not the BotFather creator's identity. Existing registration ownership cannot be reassigned merely by presenting the token. Soft-deleted bot identities are tombstoned. Deliberate ownership transfer is not implemented; recover via an audited operator procedure, not by editing ownership through an untrusted bot command.

## Credentials

Bot tokens, per-bot webhook secrets, panel URLs/credentials, incoming webhook payloads, and outgoing payloads are encrypted using Web Crypto AES-256-GCM, random 96-bit IVs and context-specific authenticated data. Context includes tenant/bot/panel/queue identifiers, so copying ciphertext between records fails authentication. Key versions are carried by each envelope; key material stays in Worker secret `MASTER_KEYS`.

Do not store production key material in D1, GitHub, logs, or browser/client interfaces. Logs contain stable error codes and record identifiers only. Upstream exception messages and panel responses are not logged. Bot tokens appear only in the official Telegram API request path, never in webhook URLs. Do not add request-URL logging around Telegram fetches.

Telegram bot conversations are not end-to-end encrypted. Registration and panel credential messages are deleted on a best-effort basis and are not echoed, but this does not erase Telegram's own processing or guarantee deletion. Use private chats; prefer narrow panel credentials where the panel supports them. This residual credential-entry risk is explicit.

## Key rotation

1. Generate a new independent 32-byte key offline.
2. Update Cloudflare `MASTER_KEYS` to include old and new versions; keep the old key.
3. Set production `KEY_VERSION` to the new version and deploy after validation.
4. Run factory `/rotate_keys BOT_ID` as a central admin for each live bot. This rewraps its token, webhook secret and panel credentials without changing plaintext or webhook identity.
5. Run factory `/rotate_finance BOT_ID` repeatedly until its bounded batch reports no remaining old-version bank, recipient, receipt or reason envelopes. `/rotate_keys` rewraps a bounded panel batch and must also be repeated when necessary.
6. Keep old keys until all persistent credentials and pending inbox/outbox items have been rewrapped/drained, dead-letter retention has elapsed, and old database backups no longer require them. Queue envelopes are not rewrapped by that command. Large panel collections may need repeated bounded operational handling; do not remove old keys based only on one command's success.
7. Inventory envelope versions offline in a protected backup before retiring any key. A revoked key intentionally makes remaining old ciphertext inaccessible. Rewrap is not automatic or a replacement for a tested recovery backup.

This is a standard cryptographic construction, not independent penetration-test certification. No claim of production readiness is made from unit tests alone.

## Webhooks and abuse

Only known routing identifiers are accepted, followed by Telegram's secret-token header verification. The token is compared via fixed-length SHA-256 digests. Bodies are streamed with a 64 KiB cap. D1 uniqueness deduplicates updates. Per-bot webhook and per-user limits are atomic D1 counters. Unauthorized endpoints cannot dispatch commands. Additional Cloudflare edge rate limits/WAF may be needed at scale and are not implicitly configured.

Panel URLs require exact trusted operator allowlisting, HTTPS/443, no credentials/query/fragment, no literal IP/localhost, and no redirects. The allowlist is a trust boundary: the operator must control/verify those domains and their DNS; this is not a universal defense against malicious DNS changes by an approved host owner. Non-approved upstream targets and TLS failures are rejected, never silently bypassed.

## Manual payment trust and evidence privacy

Only explicit authorized tenant reviewer decisions may approve card-to-card orders. Receipt content is not automatically interpreted as proof. The purchaser cannot review their own payment. Approval is a compare-and-swap decision with a current membership check in the D1 batch; the ledger, order state, durable operation and notices share that atomic batch. Unique keys prevent repeated/concurrent approvals creating another payment or service. `recordVerifiedPayment` fails closed with ONLINE_PAYMENTS_DISABLED; no provider callback or bank API route exists.

Recipient settings/order snapshots, receipt Telegram file references and rejection/additional-evidence reasons use contextual AES-GCM. File binaries are not downloaded into D1. Receipt captions are not retained. Private reviewer media is queued with protect_content and current membership is checked again before sending. Central admins must explicitly obtain an audited tenant role; central metadata views do not return evidence. This does not guarantee deletion from Telegram infrastructure, reviewer devices or backups. Manual approval is human attestation, not independently authenticated bank settlement.

No PIN, banking password or one-time bank code is requested. Recipient configuration whitelists four fields only. Never place banking secrets in instructions or receipt captions. Customer purchase/payment records are readable only by that customer or an authorized bot administrator.

## Deletion and retention

Bot deactivation immediately gates dispatch; webhook removal is attempted safely. Deletion is blocked by active services, pending/uncertain provisioning, pending manual reviews and approved-but-unfulfilled payments; only after webhook detachment does it erase bot credentials and pending bot queues while retaining audit/history. It does **not** revoke existing paid/free services on remote panels or delete customer service history. Revoke services deliberately first when required. Panel deletion is refused while plans/services reference it.

Processed/dead inbox payloads are cleared. Successful outbox payloads are cleared; sent/dead metadata is retained up to seven days. Pending/uncertain operations remain for recovery. Database exports and backups can contain historical ciphertext and operational data: protect them as sensitive.

Financial retention clears receipt references and recipient snapshots for terminal fulfilled/cancelled orders after 90 days. Pending/uncertain paid obligations are retained. Review reasons, decisions, audit and ledger remain. Old backups retain their old ciphertext and must have separate retention/access controls.
