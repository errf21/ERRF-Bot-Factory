# Remaining limitations and live acceptance gates

## Not performed

No GitHub publication/creation, Actions execution, Cloudflare resource creation/remote migration/deployment, real Telegram calls, real Sanaei panel operations or real financial review occurred in this implementation update. No real credentials were used. Local HTTP commerce verification uses a real Worker/D1 runtime with deterministic external responses. It cannot prove a live account, release-specific panel behavior, TLS routing or Telegram media delivery.

## Required before production approval

1. Authorized repository review and an actual successful CI run; production environment protection and deliberate deployment opt-in.
2. Authorized Cloudflare setup, D1 migration backup/restore rehearsal, separate encryption-key recovery and actual deployed-version/readiness/webhook verification.
3. Two real test bots with different owners: registration/repair/disable, private-chat checks, cross-tenant denial and customer-bot operation while factory account is unavailable.
4. Two supported Sanaei v2.8.5 panels: selected-panel-only create, real client connection, traffic/expiry, renewal/update/revoke, outage and uncertain-success reconciliation. Validate exact API paths/authentication and export transport settings.
5. Controlled card-to-card acceptance: recipient details, photo/document delivery to a reviewer who started the bot, concurrent/repeated approval, rejection, additional evidence, approved-payment outage/retry without double payment/client. Verify bank settlement manually; no bank/gateway API is supplied.
6. Load/subrequest/CPU/D1 quota testing and explicit alerting/incident response. Free-plan compatibility at an unknown traffic volume is not established.
7. Independent security review and recovery exercises, including stale-worker fencing, key rotation, sensitive backups and receipt retention.

## Scope boundaries

- BotFather account creation is manual; token validation proves current token control, not original BotFather ownership. Automatic ownership transfer is not implemented.
- Adapter is Sanaei 3x-ui v2.8.5 cookie authentication, not universal X-UI or 2FA login. Supported VLESS/VMess exports reject unsupported protocols/transports. Management hosts must be allowlisted HTTPS/443; public connection settings must be explicitly verified.
- No gateway, bank API, automatic screenshot approval, automated refund, chargeback reconciliation or promotional-code engine. Manual approval is a recorded human decision, not cryptographic settlement evidence. Self-approval is prohibited.
- No automatic cross-panel failover/migration. Routing failures are explicit. Renewals retain their original panel and reject unexpected remote state/unlimited finite-renewal conversions.
- Receipt binaries stay on Telegram. Encrypted local file references are erased after the implemented 90-day retention for terminal orders; this does not erase Telegram storage, reviewer devices or historical backups. Protect-content is a mitigation, not a privacy guarantee.
- Telegram sends are at-least-once; network ambiguity may repeat notifications. Claims and idempotency prevent duplicate financial/service records but do not promise exactly-once external messaging.
- Minute cron performs bounded work and is low-throughput alone. Exhausted/uncertain operations require intervention. No always-on worker process, external queue or paid feature was silently introduced.
- Persian customer/admin menus are implemented. Full English localization, a browser dashboard and complete multi-step form wizards are not shipped; sensitive setup uses validated private JSON commands.
- No automatic rollback or independent production-readiness certification. Upgrade migration preserves legacy orders as LEGACY; it does not retroactively invent receipts, payment approval or plan snapshots.
