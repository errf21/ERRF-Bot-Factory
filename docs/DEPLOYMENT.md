# One-time setup and automated deployments

## Authorization status

`https://github.com/errf21/ERRF-Bot-Factory` returned an anonymous 404 and could not be fetched without authentication. That can mean private or nonexistent; existence was not determined. No GitHub push, repository creation, Actions execution, Cloudflare resource creation, or live deployment occurred.

Use an authorized account with write permission. If the repository does not exist, its owner must create it or explicitly authorize creation. Never force-push or replace unrelated contents.

## 1. Publish safely

If the authorized repository already exists, clone it, create a feature branch, copy these project files without overwriting unrelated existing code, review the diff, commit, push, and open a pull request. Resolve existing architecture/configuration conflicts rather than blindly replacing them.

```sh
git clone https://github.com/errf21/ERRF-Bot-Factory.git
cd ERRF-Bot-Factory
git switch -c implementation/errf-factory
# Extract the delivered project into a separate directory; review/copy its files here.
npm ci --ignore-scripts
npm run check
git add .
git diff --cached --stat
# Inspect the entire staged diff, including secret exclusions, before committing.
git commit -m "Implement ERRF multi-tenant Telegram factory"
git push -u origin implementation/errf-factory
```

Protect `main` with PR review and the `validate` check. Create GitHub environment `production`; restrict its deployment branches to `main`. Use required reviewers for initial rollout. CI has read-only repository permissions; deploy access comes only from the environment's scoped Cloudflare token. Do not expose that environment to untrusted branches.

## 2. Create Cloudflare resources

Use an authorized Cloudflare account and its official Wrangler login/token flow. A deployment token should be restricted to the selected account and necessary Workers Scripts edit / D1 edit operations. Review current Cloudflare permission requirements before issuing the token. Store it in GitHub environment secret `CLOUDFLARE_API_TOKEN`; never put it in source.

```sh
npm ci --ignore-scripts
npx --no-install wrangler login
npx --no-install wrangler d1 create errf-bot-factory
```

Copy the returned D1 database UUID. Set environment variables (in your own trusted shell/secret manager) from `.env.example`:

| Variable                    | Source                                                                    |
| --------------------------- | ------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`     | Selected account's actual identifier                                      |
| `D1_DATABASE_ID`            | Confirmed `d1 create` output                                              |
| `PUBLIC_BASE_URL`           | Worker HTTPS origin, e.g. actual workers.dev hostname/custom domain       |
| `WORKER_NAME`               | Default `errf-bot-factory`                                                |
| `PANEL_ALLOWED_HOSTS`       | Comma-separated exact operator-approved public panel DNS names            |
| `KEY_VERSION`               | Default `v1`                                                              |
| `FACTORY_OPEN_REGISTRATION` | `false` by default; `true` deliberately allows customers to self-register |

These become GitHub **environment variables** as well. Account/database identifiers are not hardcoded in application source. Generated `wrangler.production.json` is ignored by Git.

Panel API addresses must be public HTTPS with trusted certificates, no embedded credentials, no redirects, and default HTTPS port. Use DNS/reverse-proxy configuration on the existing panel where required; do not disable TLS validation or add a new server silently. The runtime's allowlist is centrally controlled, not set by customer input.

## 3. Runtime secrets and first bootstrap

Set the following **locally through a secure shell/secret manager**, never by posting values in chat or committing a secret file:

| Secret                   | Format                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `MASTER_KEYS`            | JSON mapping versions to independently generated 32-byte AES keys encoded base64; e.g. `{"v1":"YOUR_GENERATED_BASE64_KEY"}` |
| `FACTORY_BOT_TOKEN`      | Actual BotFather-issued factory token                                                                                       |
| `FACTORY_WEBHOOK_SECRET` | Cryptographically random URL-safe secret, 32–256 characters                                                                 |
| `CENTRAL_ADMIN_IDS`      | Comma-separated numeric Telegram user IDs; never usernames                                                                  |
| `CLOUDFLARE_API_TOKEN`   | Authorized scoped deployment token, if not using Wrangler login                                                             |

Generate keys with a cryptographic secret manager or Node `crypto.randomBytes(32)`. Keep a protected offline recovery copy of `MASTER_KEYS`. Losing keys makes encrypted credentials unrecoverable.

```sh
ERRF_ALLOW_REMOTE_DEPLOYMENT=true npm run bootstrap
```

Bootstrap validates inputs, applies tracked remote migrations, deploys the initial inert Worker, installs runtime secrets with Wrangler stdin, checks readiness, validates the factory token, registers commands/webhook, and confirms the webhook URL. No secrets are written to the repository. An interruption may leave resources partially provisioned; rerun with the same intended identifiers. It never resets the database. A missing/invalid key makes readiness fail, not silently substitute a default key.

Runtime secrets live in Cloudflare, **not GitHub**. GitHub stores only the deploy token; CI verifies runtime secret names before migrating/deploying. The selected Worker name must match the bootstrapped Worker.

## 4. Enable automatic deployment

Remote scripts refuse to run unless `ERRF_ALLOW_REMOTE_DEPLOYMENT=true` is explicitly supplied. This flag is authorization, not a secret. Do not supply it during local validation.

After explicit publication/deployment authorization, bootstrap and acceptance testing, set the **repository variable** `ALLOW_PRODUCTION_DEPLOYMENT=true`, retain the protected `production` environment and merge the reviewed branch into `main`. Without this flag only validation runs. CI supplies the local remote-operation flag only within that gated deployment job. The workflow:

1. Installs the exact lockfile with `npm ci --ignore-scripts`.
2. Fails on moderate-or-higher dependency advisories.
3. Runs formatting, TypeScript, unit/integration tests, schema integrity, CLI flag validation, and Worker dry-run build.
4. Applies the migrations to an independent local D1 database.
5. On protected main only, enters environment `production` and serialized deployment.
6. Generates environment-specific configuration, validates required secret names, applies tracked remote migrations, and deploys.
7. Verifies `/readyz` reports this exact commit and an unauthenticated factory webhook is rejected with 401.
8. Reports the job result. Failure requires inspection; there is no claimed automatic rollback.

D1 migrations run **before** the new Worker. Future migrations must preserve compatibility with the previous deployed version. Migration `0004` is additive and preserves pre-existing rows as LEGACY without inventing payment approval or snapshots. Review `0003` carefully if an existing database already has duplicate open orders: reconciliation is required before creating its unique index. The migration fails rather than deleting records.

The deployment health check does not prove real panel reachability, successful payments, or end-to-end Telegram delivery. Complete those acceptance gates separately.
