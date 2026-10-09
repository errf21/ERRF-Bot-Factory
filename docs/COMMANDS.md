# Telegram commands

All administrative commands must be sent in private chats by explicitly authorized numeric Telegram IDs. JSON arguments must fit a Telegram message; they are validated and never echoed when they contain credentials.

## Factory

- `/start`, `/help`: registration instructions
- `/register TOKEN`: validate and register a BotFather-created bot; closed to non-central users unless `FACTORY_OPEN_REGISTRATION=true`
- `/mybots`, `/bot_status BOT_ID`
- `/bot_activate BOT_ID`, `/bot_deactivate BOT_ID`, `/bot_repair BOT_ID`
- `/bot_delete BOT_ID CONFIRM`: safe tombstone/credential removal; remote customer services are not silently deleted

## Customer bot: customers

- `/start`, `/help`
- `/buy [PAGE]`: select actual destination panel
- `/choose PANEL_ID [PAGE]`: panel-specific plans, with prices in minor currency units
- Plan preview → expiring checkout confirmation creates an idempotent order. Existing open order for the same customer/plan is reused.
- `/order ORDER_ID`, `/receipt ORDER_ID`, `/renew_catalog SERVICE_ID`, `/renew_offer SERVICE_ID PLAN_ID`
- `/orders`, `/cancel_order ORDER_ID` (only unpaid/unconfigured orders)
- `/services`, `/service SERVICE_ID`: actual usage and remote client information
- `/connect SERVICE_ID`: actual supported connection export; owner must configure verified public transport parameters first
- `/history SERVICE_ID`

## Customer bot: owners/admins

`/admin` shows the core setup commands.

```text
/panel_add {"name":"Main","url":"https://approved-panel.example/base/","username":"USER","password":"PASSWORD"}
/panel_edit {"id":"PANEL_ID","name":"Renamed","connection_host":"verified-node.example","connection_port":443}
/panel_edit {"id":"PANEL_ID","reality_public_key":"VERIFIED_43_CHARACTER_PUBLIC_KEY"}
/panel_test PANEL_ID
/inbounds PANEL_ID
/panels [PAGE]
/panel_toggle PANEL_ID on
/panel_toggle PANEL_ID off
/panel_default PANEL_ID
/panel_delete PANEL_ID CONFIRM

/plan_add {"name":"1 GB / 30 days","description":"Plan description","panel_id":"PANEL_ID","inbound_id":1,"bytes":1073741824,"days":30,"price_minor":0,"currency":"IRR"}
/plan_edit {"id":"PLAN_ID","enabled":false,"price_minor":10000}
/plans [PAGE]

/config {"welcome":"خوش آمدید","help":"راهنما","support":"@your_verified_support","menu_buy":"خرید","menu_services":"سرویس‌ها","sales_enabled":true,"notifications_enabled":true,"panel_selection":"choose","language":"fa"}
/display_name Telegram bot display name
/admin_add NUMERIC_USER_ID
/admin_remove NUMERIC_USER_ID

/renew {"id":"SERVICE_ID","days":30}
/service_update {"id":"SERVICE_ID","bytes":2147483648,"expires_at":1800000000}
/revoke SERVICE_ID
/retry OPERATION_ID
/report
/tenant_audit
```

Only primary owners manage tenant administrators. Renew/update/revoke are deliberate administrative service changes, not a fake customer payment flow. Expiry is an integer Unix timestamp in **seconds**; the adapter converts it to panel milliseconds. Data limits are bytes; plan prices are integer minor units, never floating-point money.

Panel version is fixed to the Sanaei v2.8.5 profile. Do not use these credentials/configuration commands for arbitrary forks and assume compatibility. Connectivity remains UNTESTED until the test succeeds. URLs must match centrally approved hostnames. No fixed number of panels is imposed; discovery is paginated.

Connection export supports VLESS TCP/WebSocket/gRPC with none/TLS/Reality security, subject to supported settings; VMess TCP/WebSocket with none/TLS. Unsupported headers/transports are explicit errors. Public transport hostname/port must match the real endpoint. Reality public keys must be verified—not private keys. The API login receives only the username/password, not connection-export settings.

## Central administrator: factory

- `/admin`, `/bots`, `/stats`, `/health`, `/errors`, `/audit`
- `/tenant_stats BOT_ID`, `/panel_health BOT_ID`
- `/central_bot BOT_ID activate|deactivate|repair|delete [CONFIRM]`
- `/central_admin add|remove NUMERIC_USER_ID` (bootstrap IDs only)
- `/global registration_paused true|false`
- `/rotate_keys BOT_ID` (read key-retirement caveats in SECURITY.md first)

Health diagnoses application queues/D1 independently of panel connectivity. Central lists and reports are intentionally bounded; they are not an exhaustive bulk database export.

## Manual commerce and routing (customer bot admins)

- `/bank`, `/bank_set {"card_number":"16 digits","recipient_name":"Name","instructions":"Instructions","enabled":true}`
- `/payments [PAGE]`, `/review REVIEW_ID`, `/admin_order ORDER_ID`
- `/approve REVIEW_ID`: preview; `/confirm_pay REVIEW_ID`: explicit manual decision
- `/ask_reject REVIEW_ID`, `/ask_more REVIEW_ID`: reason prompts
- `/reject REVIEW_ID REASON`, `/more REVIEW_ID REASON`
- `/plan_manage PLAN_ID`, `/plan_publish PLAN_ID`: verified actual inbound/export before publication
- `/panel_view PANEL_ID`, `/manage_help`
- `/routes`, `/route_add {"customer_id":NUMERIC_ID,"panel_id":"PANEL_ID"}`, `/route_remove NUMERIC_ID`
- `/import_config {"panel_id":"PANEL_ID","inbound_id":1,"customer_id":NUMERIC_ID,"uri":"SUPPORTED_EXISTING_CONNECTION_URL"}`

New plans are drafts. Current tenant membership is mandatory; the purchaser cannot approve their own receipt. Approval records a manual attestation, then schedules provisioning; screenshots alone never mark payment paid. Finite paid renewal rejects unlimited imported services and remote baseline changes. See USER_GUIDE.md for the complete flow.

## Additional central commands

- `/central_status BOT_ID`, `/central_payments BOT_ID` (metadata only)
- `/central_grant BOT_ID NUMERIC_ID`: explicit audited tenant ADMIN grant, not automatic private receipt access
- `/rotate_finance BOT_ID`: bounded rewrap; repeat until no old-version financial envelopes remain
