# Rollback: Single Control-Plane VM

## Fast rollback
Use a previously installed release ID from `/opt/mines-ai/releases`.

```bash
sudo ./scripts/deploy/rollback-single-vm.sh \
  --release-id <previous-release-id> \
  --domain mines-ai.com \
  --env-file /opt/mines-ai/shared/.env
```

This script:
1. repoints `/opt/mines-ai/current`,
2. restarts `cloud-sql-proxy`, `mines-ai-api`, and `caddy`,
3. runs smoke checks.

List available release IDs:

```bash
ls -1 /opt/mines-ai/releases
readlink -f /opt/mines-ai/current
```

## Manual rollback (if script unavailable)

```bash
sudo ln -sfn /opt/mines-ai/releases/<previous-release-id> /opt/mines-ai/current
sudo systemctl restart cloud-sql-proxy mines-ai-api caddy
sudo ./scripts/deploy/smoke-check.sh --domain mines-ai.com --env-file /opt/mines-ai/shared/.env
```

## Verify

```bash
curl -fsS https://mines-ai.com/api/health
sudo systemctl status mines-ai-api caddy cloud-sql-proxy --no-pager
```

## If rollback fails
1. Inspect API logs:
   - `sudo journalctl -u mines-ai-api -n 200 --no-pager`
2. Validate env:
   - `sudo ./scripts/deploy/validate-env.sh --env-file /opt/mines-ai/shared/.env`
3. Check Cloud SQL proxy status/logs:
   - `sudo systemctl status cloud-sql-proxy --no-pager`
   - `sudo journalctl -u cloud-sql-proxy -n 200 --no-pager`

## GitHub Actions rollback
Use `.github/workflows/rollback-single-vm.yml` in GitHub Environment `production`.
The workflow prints available release IDs and current symlink before executing rollback.
