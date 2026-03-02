# Deploy: Single Control-Plane VM

## Overview
This runbook deploys Mines AI control-plane services (API + frontend + TLS proxy) on one VM.

Sandbox workloads continue running on per-agent GCE VMs managed by reconciler.

## Production vs Dev
- Production does **not** use Cloudflare tunnel.
- Do not set `CLOUDFLARED_TUNNEL_TOKEN` for production runtime.
- Set `API_CALLBACK_URL=https://mines-ai.com`.

## Prerequisites
1. Domain DNS points to the control-plane VM:
   - `A` record for `mines-ai.com`
   - optional `www` record
2. Firewall allows inbound ports `80` and `443`.
3. Control-plane VM has an attached GCP service account with at least:
   - `roles/cloudsql.client`
   - compute permissions required by reconciler lifecycle actions
4. Cloud SQL instance exists and `CLOUD_SQL_INSTANCE_CONNECTION_NAME` is known.
5. Release artifacts exist:
   - server tarball
   - client tarball

## 1) Bootstrap VM
Run once as root on the control-plane VM:

```bash
cd /path/to/repo
sudo ./scripts/deploy/bootstrap-single-vm.sh --domain mines-ai.com --deploy-user <ssh-deploy-user>
```

This installs Node 22, Caddy, Cloud SQL proxy binary, creates `mines-ai` user, sets folders, installs systemd unit files, and copies deploy scripts to `/opt/mines-ai/scripts/deploy`.
It also installs a local LiteLLM proxy runtime (`/opt/mines-ai/litellm-venv`) and seeds `/opt/mines-ai/shared/litellm-config.yaml`.
`mines-ai-api` is enabled during first `install-release.sh` run (after `/opt/mines-ai/current` exists).
When `--deploy-user` is set, bootstrap adds a scoped sudoers rule that allows only:
- `/opt/mines-ai/scripts/deploy/install-release.sh`
- `/opt/mines-ai/scripts/deploy/check-quiescence.sh`
- `/opt/mines-ai/scripts/deploy/smoke-check.sh`
- `/opt/mines-ai/scripts/deploy/rollback-single-vm.sh`

## 2) Configure environment
Create `/opt/mines-ai/shared/.env` with required variables.

Reference: `docs/operations/runtime-env.md`

Validate:

```bash
sudo ./scripts/deploy/validate-env.sh --env-file /opt/mines-ai/shared/.env
```

## 3) Install release

```bash
sudo ./scripts/deploy/install-release.sh \
  --release-id <git-sha-or-release-id> \
  --server-tar /tmp/server.tar.gz \
  --client-tar /tmp/client.tar.gz \
  --domain mines-ai.com \
  --env-file /opt/mines-ai/shared/.env
```

The installer:
1. validates env,
2. validates required runtime config files under `/opt/mines-ai/deploy/`,
3. extracts release files to `/opt/mines-ai/releases/<id>`,
4. prunes older release directories (keeps latest `KEEP_RELEASE_COUNT`, default `5`),
5. enters deploy drain mode (creates `/opt/mines-ai/shared/.deploy-draining`) so new chat turns are rejected with retry semantics,
6. waits for quiescence (`active_stream_lease_until` + running goal runs) using `check-quiescence.sh`,
7. switches `/opt/mines-ai/current`,
8. restarts services,
9. runs smoke checks,
10. auto-rolls back on smoke-check failure and re-runs smoke checks on the restored release.

Drain wait defaults:
- timeout: `300s` (`DEPLOY_DRAIN_TIMEOUT_SECONDS`)
- poll interval: `3s` (`DEPLOY_DRAIN_POLL_SECONDS`)

## 4) Verify runtime health

```bash
sudo ./scripts/deploy/smoke-check.sh --domain mines-ai.com --env-file /opt/mines-ai/shared/.env
```

Manual checks:

```bash
curl -fsS https://mines-ai.com/ >/dev/null
curl -fsS https://mines-ai.com/api/health
sudo systemctl status mines-ai-api caddy cloud-sql-proxy --no-pager
sudo systemctl status litellm-proxy --no-pager
```

## 5) Common operations
Restart API:

```bash
sudo systemctl restart mines-ai-api
```

Tail logs:

```bash
sudo journalctl -u mines-ai-api -f
sudo journalctl -u caddy -f
sudo journalctl -u cloud-sql-proxy -f
sudo journalctl -u litellm-proxy -f
```

## 6) GitHub Actions deployment (manual dispatch from main)
`.github/workflows/deploy-single-vm.yml` is `workflow_dispatch` only. CI still runs on PRs and `main`,
but deploy is intentionally explicit.

Recommended developer flow:
1. Merge PR into `main` (CI runs).
2. On local `main`, run:

```bash
pnpm run deploy
```

`pnpm run deploy`:
- verifies local HEAD exactly matches `origin/main`,
- syncs `PROD_APP_ENV` from local `.env`,
- dispatches deploy workflow with `release_id=origin/main SHA`,
- watches run status.

Note: `pnpm deploy` is a built-in pnpm subcommand, so use `pnpm run deploy`.

Useful variants:

```bash
pnpm run deploy -- --dry-run
pnpm run deploy -- --dry-run --allow-dirty
pnpm run deploy -- --skip-env-sync
pnpm rollback -- --release-id <release-id>
pnpm smoke:prod
```

Required GitHub secrets:
- `PROD_SSH_HOST`
- `PROD_SSH_USER`
- `PROD_SSH_PORT`
- `PROD_SSH_PRIVATE_KEY`
- `PROD_SSH_KNOWN_HOSTS` (from `ssh-keyscan -H <host>`)
- `PROD_APP_ENV` (full production `.env` content; workflow writes it to `${PROD_ENV_FILE}` each deploy)

Required GitHub variables:
- `PROD_DOMAIN` (for example `mines-ai.com`)
- Optional `PROD_ENV_FILE` (default `/opt/mines-ai/shared/.env`)
- Optional `PROD_STAGING_DIR` (default `/tmp/mines-ai-release`)

Release artifact contract used by workflow:
- Server package source: `dist/` + `src/db/migrations/` + root `package.json` + root `pnpm-lock.yaml` + root `node_modules/`
- Client package source: `client/dist/`
- Deploy/runtime config package source: `scripts/deploy/`, `deploy/systemd/`, `deploy/caddy/`
- LiteLLM config package source: `deploy/litellm/`
- Server tar extracts to `/opt/mines-ai/releases/<id>/server`
- Client tar extracts to `/opt/mines-ai/releases/<id>/client`
- Upload staging path: `${PROD_STAGING_DIR}/<id>/` (no direct writes to `/opt/mines-ai` before sudo install)
- Workflow syncs deploy scripts and runtime config from `deploy-config.tar.gz` into `/opt/mines-ai/scripts/deploy` and `/opt/mines-ai/deploy/*` before `install-release.sh`

Release ID behavior:
- manual dispatch: deploys `release_id` input when provided, otherwise `GITHUB_SHA`

Local developer secret-sync flow:
1. Keep credentials in local `.env`.
2. Run `pnpm env:doctor` (or directly run `scripts/secrets/sync-production-env-from-dotenv.sh --dry-run ...`) to validate.
3. Run `pnpm run deploy` to sync `PROD_APP_ENV` and dispatch deploy. Workflow syncs `PROD_APP_ENV` to `${PROD_ENV_FILE}` before install.
