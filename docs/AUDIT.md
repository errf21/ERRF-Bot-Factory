# Existing-source inspection and remediation

Before edits, all 51 tracked text files were inventoried with paths, line counts and hashes (baseline commit `4404e71`, v0.1.0). See `baseline-inventory.json`. The baseline release check passed 92 tests. Working factory, crypto, adapter, tenant schema, free provisioning, connection export and recovery infrastructure were retained rather than replaced with a mock application.

| Baseline issue or missing workflow                                | Actual change                                                                                                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Paid plans stopped at unconfigured state                          | Encrypted recipient settings, immutable terms, receipt submission, independent manual decisions, guarded ledger and provisioning         |
| No private receipt review/history                                 | Encrypted file references/reasons, reviewer/time records, additional-evidence lifecycle, role-checked protected outbox                   |
| Paid renewal order correlation absent                             | Separate renewal order and operation.order_id, original panel/inbound, absolute quota/expiry and remote baseline reconciliation          |
| Editable checkout terms                                           | Expiring customer-bound fingerprint confirmation plus immutable order snapshot                                                           |
| Plans could be exposed before export validation                   | Draft by default; publish reads actual inbound and checks supported export                                                               |
| Static panel selection                                            | Business-layer default/customer routes, explicit destination preview, no silent fallback                                                 |
| Stale worker could finalize after losing lease                    | Claim IDs fence inbox, outbox, operation finalization and associated notices                                                             |
| Exhausted stale claims could strand work                          | Explicit UNKNOWN/dead-letter recovery and retained paid obligations                                                                      |
| Credential rotation omitted new finance records                   | Bounded finance rewrap with contextual AES-GCM and compare-and-swap                                                                      |
| Financial evidence retention undefined                            | Terminal-order reference/snapshot retention and transient session cleanup                                                                |
| Telegram fetch used unsupported Workers redirect mode             | Real HTTP commerce test exposed redirect:error incompatibility; runtime uses manual and rejects 3xx without following token-bearing URLs |
| Remote scripts/CI could deploy once configured without new opt-in | Explicit local remote-operation gate and disabled-by-default repository deployment flag                                                  |
| Only empty migration validation                                   | Populated 18-table legacy-upgrade fixture, original-value preservation, integrity and foreign-key checks                                 |

The test suite exercises real local D1/workerd and simulated external responses. Mocks live only in tests; production adapters make actual authenticated calls. This inspection is not an independent penetration test or proof of live deployment readiness. See VERIFICATION.md and LIMITATIONS.md.
