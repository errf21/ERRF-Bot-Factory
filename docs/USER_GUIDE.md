# Operator and customer guide

Commands below use placeholders, not live credentials. Send them only in the appropriate bot's private chat. Buttons mirror the principal catalog, panel, order, service and payment-review actions. Numeric Telegram IDs identify users; usernames do not grant permissions.

## 1. Register a customer bot and reviewers

1. Create the customer bot using BotFather. In the factory send `/register TOKEN` from the intended owner's account. Default registration is closed unless the operator explicitly opens it.
2. Use `/mybots` and `/bot_status BOT_ID`. Repair incomplete configuration with `/bot_repair BOT_ID`; this reconciles the existing registration, not a new running process.
3. Open the customer bot and send `/start`, then `/admin` from the owner account.
4. Add an independent reviewer using `/admin_add NUMERIC_USER_ID`. Reviewers must open **this customer bot** and `/start` before it can send them evidence. The purchaser cannot approve their own receipt.
5. Central admins do not implicitly get receipt access. Factory `/central_grant BOT_ID NUMERIC_USER_ID` explicitly records an audited tenant ADMIN grant. The granted person then reviews through the customer bot. Factory `/central_payments BOT_ID` shows operational metadata, not private evidence.

Never send tokens or panel passwords to this chat, source files or public groups. Credential-bearing Telegram commands are deleted best-effort, but Telegram bot conversations are not end-to-end encrypted.

## 2. Add multiple panels

The operator first approves each actual panel DNS hostname in deployment `PANEL_ALLOWED_HOSTS`. Use public HTTPS/443, trusted certificates, the correct API base path and the verified Sanaei v2.8.5 profile. Arbitrary X-UI forks/2FA-only logins are not promised.

In the customer bot:

```text
/panel_add {"name":"Main","url":"https://approved-panel.example/base/","username":"PANEL_USER","password":"PANEL_PASSWORD"}
/panel_add {"name":"Secondary","url":"https://second-approved.example/base/","username":"PANEL_USER","password":"PANEL_PASSWORD"}
/panels
/panel_test PANEL_ID
/inbounds PANEL_ID
/panel_edit {"id":"PANEL_ID","name":"Main Tehran","connection_host":"verified-node.example","connection_port":443}
/panel_default PANEL_ID
```

Use the real public client-connection hostname, which may differ from the management API host. Configure supported Reality public keys when necessary; never substitute a private key. `/panel_toggle PANEL_ID on|off` enables/disables selection. `/panel_delete PANEL_ID CONFIRM` refuses referenced panels; retire plans/services deliberately rather than erasing references. No fixed three-panel limit exists; runtime quotas still apply.

## 3. Create and publish panel-specific plans

```text
/plan_add {"name":"۱۰ گیگ، ۳۰ روز","description":"شرح واقعی سرویس","panel_id":"PANEL_ID","inbound_id":1,"bytes":10737418240,"days":30,"price_minor":1000000,"currency":"IRR"}
/plans
/plan_publish PLAN_ID
```

New plans are drafts. Publication reads the selected panel's actual inbound and verifies supported connection export with configured public settings. Failure leaves the plan unavailable. Inspect the selected panel before publishing. Price is integer minor units; `IRR` values are rial, not toman. There is no currency conversion. Zero price means a real free plan and provisions without a receipt.

```text
/plan_edit {"id":"PLAN_ID","description":"شرح جدید","price_minor":1200000}
/plan_edit {"id":"PLAN_ID","enabled":false}
/plan_edit {"id":"PLAN_ID","enabled":true}
```

Enabling also validates publication. An old checkout preview cannot silently accept changed terms; the customer must reconfirm. Existing orders keep their original price, quota, duration, panel and recipient snapshot.

## 4. Configure card-to-card payment

```text
/bank_set {"card_number":"RECIPIENT_16_DIGITS","recipient_name":"نام گیرنده","instructions":"مبلغ را به کارت مقصد واریز کنید و رسید واضح بفرستید.","enabled":true}
/bank
```

Replace the card placeholder with the recipient's actual 16 digits. Only these four fields are accepted; Persian/Arabic digits are normalized. `/bank` masks the card. Disable with the same configured details and `enabled:false`. **No PIN, banking password or authentication code is requested or needed.** Never put secrets in the free-text instructions.

Paid orders without configured recipient details are explicitly `UNCONFIGURED`, not paid/provisioned. Cancel such an unpaid order and place a fresh order after fixing settings; existing recipient snapshots are not rewritten.

## 5. Select the destination panel

Default configuration presents panels first, then that panel's plans, then a summary naming the panel before checkout. To require the default:

```text
/config {"panel_selection":"default"}
```

For a specific customer:

```text
/route_add {"customer_id":NUMERIC_CUSTOMER_ID,"panel_id":"PANEL_ID"}
/routes
/route_remove NUMERIC_CUSTOMER_ID
```

Rules are enforced in the order engine, not merely hidden menus. A disabled/unavailable destination causes an explicit error. There is **no silent fallback**. Renewals remain on the original service panel even if default/routing settings change.

## 6. Customer purchase and receipt

1. Customer `/start` → خرید → panel → plan.
2. Preview the actual panel, quota, validity and price; confirm the expiring checkout intent.
3. The order shows its UUID, exact payable amount/currency, recipient card/name and instructions.
4. Customer transfers using their own banking application; the bot does not interact with the bank.
5. Choose the receipt button (15-minute order-specific session) and send a photo, or JPEG/PNG/PDF document no larger than 10 MiB. An explicit caption `/receipt ORDER_ID` also associates evidence. Captions are not retained as evidence text.
6. Order becomes pending manual review. The customer can inspect `/orders` or `/order ORDER_ID`. Sending evidence never creates a payment or service.

The database stores encrypted Telegram file references, not receipt binaries. Telegram-hosted files must be treated as sensitive; see SECURITY.md. An unclear receipt should not be approved.

## 7. Review and decide

Reviewer `/payments` → select receipt → inspect order and protected media. The review is confined to the original customer bot and current tenant membership.

- Approve: select approval preview, check actual receipt/amount/destination against independently verified account information, then explicit confirmation. `/approve REVIEW_ID` previews; `/confirm_pay REVIEW_ID` performs the decision.
- Reject: button prompts for a reason, or `/reject REVIEW_ID Reason`. The order becomes cancelled/rejected; history retains reviewer/time/reason.
- More evidence: button prompts for a reason, or `/more REVIEW_ID Reason`. Customer can send new evidence; the old review decision remains recorded.

First valid decision wins. Repeated/concurrent confirmation cannot add another payment or CREATE operation. Current role is rechecked before committing and sending private evidence. The purchaser cannot self-approve. Manual approval records the administrator's attestation, **not independently proven bank settlement**.

## 8. Delivery and paid failure recovery

Approval atomically records the manual payment and durable operation. The selected panel is queried/reconciled, service is created with its stable client ID, then the order becomes fulfilled and the customer gets service controls. `/service SERVICE_ID` shows actual panel usage/status; `/connect SERVICE_ID` exports supported connection details; `/history SERVICE_ID` shows operations.

If the panel is unavailable, the paid order remains recoverable. Review `/report` in the customer bot or central `/errors`; repair credentials/TLS/panel state, then `/retry OPERATION_ID`. Retry reconciles the original client before mutation and does not request another payment. Never manually create another client or change the order's panel to bypass failure. Notifications may repeat after uncertain Telegram responses; the ledger/service idempotency is separate.

## 9. Renew, update, revoke, import/export

- Customer opens a service's renewal menu (`/renew_catalog SERVICE_ID`), selects a compatible plan on its original panel/inbound and repeats manual payment/review. Renewal has its own order and payment; remote quota/expiry are absolute targets. Remote drift is a visible conflict, not overwritten silently. Unlimited imported quotas/expiry are not eligible for this finite customer renewal flow.
- Admin `/renew {"id":"SERVICE_ID","days":30}` is a deliberate administrative extension, **not** payment confirmation. `/service_update {"id":"SERVICE_ID","bytes":2147483648,"expires_at":1800000000}` changes supported absolute values. `/revoke SERVICE_ID` reconciles remote absence. Confirm timestamps/units: expiry seconds, bytes for traffic.
- Import an existing supported client:

```text
/import_config {"panel_id":"PANEL_ID","inbound_id":1,"customer_id":NUMERIC_CUSTOMER_ID,"uri":"vless://EXISTING_UUID@actual-node.example:443?type=tcp&security=tls"}
```

Import parses the identity and verifies it exists in the selected panel; it does not create a remote client, fetch an arbitrary URL or import unverified arbitrary configuration. VMess UUID extraction is also supported. Export uses actual panel settings and verified public host.

## 10. Central operation and safe retirement

Factory `/bots`, `/central_status BOT_ID`, `/tenant_stats BOT_ID`, `/panel_health BOT_ID`, `/central_payments BOT_ID`, `/errors`, `/audit`, `/health` provide protected diagnostics. `/central_bot BOT_ID activate|deactivate|repair|delete [CONFIRM]` manages lifecycle. Only bootstrap admins manage central admin grants. Loss of factory access does not destroy customer bot state.

Deletion is blocked by active services, pending/uncertain operations, pending receipt reviews or paid unfulfilled obligations. Resolve/revoke deliberately first. Back up D1 and the separate key ring before upgrades; follow OPERATIONS.md. Do not publish or deploy until explicitly authorized and the live acceptance checklist passes.
