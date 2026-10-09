# Verification report — ERRF Bot Factory 0.2.0

Local release validation completed on **2026-10-09**. Results below are executed evidence, not merely prepared CI steps. Node 24, pinned Wrangler 4.149.0 and the locked TypeScript/Miniflare toolchain were used. Baseline v0.1.0 had 92 passing tests; the updated application has 141.

| Command/check executed                                     | Actual result                                                                                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci --ignore-scripts`                                  | Exit 0; 84 packages installed from lockfile                                                                                         |
| `npm run check` → `npm run lint`                           | Exit 0; Prettier check passed                                                                                                       |
| `npm run check` → `npm run typecheck`                      | Exit 0; application `tsc --noEmit` passed                                                                                           |
| `npm run check` → `npm test`                               | **141 passed, 0 failed, 11 files**; 48.67-second recorded suite                                                                     |
| `npm run check` → `npm run validate:migrations`            | All **4** migrations; integrity, cross-tenant FK rejection and populated upgrade preserving original values in **18 legacy tables** |
| `npm run check` → `npm run validate:tooling`               | Installed deployment/secret/migration CLI flags accepted via `--help`; no remote action                                             |
| `npm run check` → `npm run build`                          | Worker `wrangler deploy --dry-run --outdir dist` passed; 163.49 KiB / gzip 35.50 KiB                                                |
| `npm audit --audit-level=moderate` and `npm audit --json`  | Exit 0; **0 reported vulnerabilities** at check time                                                                                |
| `npx --no-install wrangler d1 migrations apply DB --local` | Exit 0; 0004 applied to the existing local D1 (23 commands successful)                                                              |
| Same local migration command repeated                      | Exit 0; **No migrations to apply**                                                                                                  |
| Python `yaml.safe_load` and deployment assertions          | Parsed; deploy requires validate, protected production environment and explicit repository opt-in                                   |
| Remote script authorization tests                          | Deploy/bootstrap reject absent opt-in before configuration or remote calls                                                          |
| `git diff --check`                                         | Exit 0; no whitespace errors                                                                                                        |

No remote GitHub/Cloudflare operations or real credentials were used. CI/CD was prepared and locally validated, **not executed on GitHub**. The source was not published, and the Worker was not live-deployed. Payment gateways/bank APIs are intentionally absent: this release implements manual card-to-card approval.

## End-to-end evidence

`tests/worker-commerce-e2e.test.ts` sends actual HTTP webhook requests to the bundled Worker in local workerd, persists encrypted updates to real local D1, processes customer plan confirmation and photo evidence, performs an independent manual approval, runs the durable panel operation, drains notifications through the scheduled recovery handler, delivers the service connection and checks duplicate confirmation creates only one payment/client. Telegram and panel responses are supplied by an isolated outboundService; there is no production-mock adapter or live external traffic.

This test exposed an actual runtime defect: `redirect:"error"` in Telegram fetch was rejected by workerd. Production Telegram fetch now uses `manual` and explicitly rejects redirects. The test itself was corrected to use this installed Miniflare version's `/cdn-cgi/local/scheduled` trigger. Earlier failed attempts are not represented as successful evidence; the final complete run above passed.

## Coverage executed

- Original factory registration/token validation, duplicate ownership, webhook failure/repair/lifecycle, encryption/tampering/key recovery, cross-tenant FK and command authorization, private-chat checks and rate limits.
- Paid/free/unconfigured orders; recipient field validation; plan fingerprint changes; immutable terms; customer-bound receipts, supported format/size/session checks, no auto-payment on screenshots and no self-approval.
- Concurrent/duplicate approval versus rejection; current-admin authorization; revoked reviewer delivery; database batch failure; rejection reasons, additional evidence and decision history.
- Paid creation/renewal order correlation; selected original panel only; uncertain-success reconciliation; failed paid retry without another transfer/client; expiry anchoring; finite-renewal rejection for unlimited imported services.
- Draft/publication validation, multi-panel routing, verified existing-client import without remote mutation, actual usage/connection export, panel failures and permanent conflicts.
- Durable inbox/outbox and claim fences, exhausted leases, Unicode-safe messages, financial key rewrap and terminal evidence retention.
- Central explicit tenant delegation, configuration/tooling validation and disabled-by-default deployment authorization.

## Remaining live tests and production boundaries

Real Telegram media/webhook delivery, actual Sanaei v2.8.5 APIs on two panels, real client connectivity/usage, controlled bank-transfer human review, outage/recovery, Cloudflare load/quota behavior, actual CI/deployment, backup restoration and independent security review remain unverified. Follow `LIMITATIONS.md` before calling this production-ready.

Miniflare v5 is the pinned prerelease used by the installed Wrangler toolchain, via its official v4-options converter. It is local development tooling, not a production dependency/service. Review toolchain maturity and dependency advisories again before rollout.

## Evidence and guides

- `test-output.txt`: full final local check output with terminal styling removed
- `migration-output.txt`, `install-output.txt`, `audit-output.txt`: executed results
- `verification.json`: machine-readable commands/results and explicit external status
- `AUDIT.md`, `baseline-inventory.json`: baseline inspection and remediation
- `USER_GUIDE.md`: adding multiple panels, selecting destination, purchases, receipt review and delivery
- `SECURITY.md`, `OPERATIONS.md`, `DEPLOYMENT.md`, `LIMITATIONS.md`: security/recovery/setup and remaining gates

Official APIs targeted: Telegram Bot API (`https://core.telegram.org/bots/api`), Cloudflare Wrangler/D1 documented interfaces and Sanaei 3x-ui v2.8.5 inbound API. This is an independently implemented application, not imported ZitaSaz code.
