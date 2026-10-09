# ERRF Bot Factory

Independent TypeScript Telegram bot factory running on Cloudflare Workers + D1. One shared runtime serves the factory and isolated customer bots. No VPS, Docker, Redis, external database, payment gateway, bank API, or KV is introduced.

## Version 0.2.0: manual card-to-card commerce

Executable code implements:

- Token validation, encrypted registration, unique bot identity/ownership, webhook configuration, activation, disabling, repair and guarded deletion.
- Tenant-scoped customers, administrators, settings, panels, plans, orders, services and audit records; numeric-ID/private-chat authorization and composite foreign keys.
- Persian interactive catalog, explicit selected-panel/price preview, expiring checkout confirmations and immutable order terms.
- Multiple Sanaei **3x-ui v2.8.5** panels; connectivity, inbounds, public connection settings, draft/publication validation, default/customer-specific routing. No silent cross-panel fallback.
- Configurable encrypted recipient card details; receipt photo/JPEG/PNG/PDF references; private manual review, approval, rejection with reason or request for more evidence. **No screenshot automatically proves payment.** Independent administrator approval atomically records the ledger and schedules provisioning.
- Stable service/client identifiers, durable operations, reconciliation before repeated mutations, safe paid retries without another payment, actual remote usage, connection export, customer renewals on the original panel, administrative update/revoke and verified existing-client import.
- AES-256-GCM contextual encryption/versioned keys, encrypted inbox/outbox/evidence references, role-checked private receipt delivery, rate limits, claim fencing, bounded retries, audit and health endpoints.
- Four additive migrations, populated legacy-upgrade checks, automated tests, pinned dependencies, SHA-pinned CI and **disabled-by-default** guarded remote deployment.

## Delivery status and limits

See `docs/VERIFICATION.md` for executed checks and `docs/LIMITATIONS.md` for remaining acceptance gates. The Worker HTTP commerce test uses a real local workerd/D1 runtime and controlled Telegram/panel responses. It is not live integration proof. No repository publication, GitHub Actions run, Cloudflare deployment or real credentials were used for this update. **Production readiness is not certified.**

Bot accounts must first be created in BotFather: the Bot API cannot automate BotFather account creation. Only the verified adapter profile and supported VLESS/VMess transports are implemented. Telegram sends are at-least-once; a repeated notification is possible. There is no automatic refund, bank settlement verification, cross-panel migration/failover or promotional-code engine. Administrative configuration uses validated JSON commands alongside interactive browsing/review controls; it is not an all-fields wizard.

## Local validation

Node 24 and Python 3:

```sh
npm ci --ignore-scripts
npm run check
npm audit --audit-level=moderate
npx --no-install wrangler d1 migrations apply DB --local
npm run dev
```

`wrangler.json` contains intentionally unusable production identifiers. Credential-dependent local work requires ignored `.dev.vars`; never commit it. Tests use synthetic credentials and do not contact Telegram or panels.

## Guides

- `docs/USER_GUIDE.md`: panels, plans, purchase, manual review, delivery and renewals
- `docs/COMMANDS.md`: command reference
- `docs/DEPLOYMENT.md`: authorized one-time setup and gated CI/CD
- `docs/SECURITY.md`: trust boundaries, encryption, financial privacy and key rotation
- `docs/OPERATIONS.md`: durable recovery, backup, rollback and capacity
- `docs/AUDIT.md`: baseline inspection and actual remediation
- `docs/VERIFICATION.md`, `docs/verification.json`: executed results
- `CHANGELOG.md`: actual versioned changes

Remote scripts require explicit `ERRF_ALLOW_REMOTE_DEPLOYMENT=true`. CI production deployment additionally requires repository variable `ALLOW_PRODUCTION_DEPLOYMENT=true` and the protected production environment. Do not enable either until authorization, secrets, backups and live acceptance testing are ready.
