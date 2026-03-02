# Phase 7: Deployment (Single Control-Plane VM)

## Status

in_progress

## Depends on

- Phase 6

## Deployment Model

- One control-plane VM runs API + frontend + reverse proxy/TLS.
- Sandbox workloads continue to run on per-agent GCE VMs managed by reconciler.
- Cloud SQL (or managed Postgres) is the production database target.
- Sandbox image CI/CD remains image-driven: candidate -> promoted -> rollback -> retention.

## Tasks (with acceptance criteria)

- [x] Add sandbox image build/promotion/rollback/retention workflows in GitHub Actions.
  - Acceptance criteria: runtime images are built from promoted base images; candidate GCE images are labeled with `image_type` (`base`/`runtime`) and version labels (`base_version`/`runtime_version`); manual promote/rollback workflows keep one image `state=promoted` per image type; scheduled cleanup removes stale non-promoted images with independent retention windows for base/runtime.
  - Files: `.github/workflows/sandbox-image.yml`, `.github/workflows/sandbox-image-promote.yml`, `.github/workflows/sandbox-image-rollback.yml`, `.github/workflows/sandbox-image-retention.yml`, `.github/workflows/sandbox-base-image.yml`, `.github/workflows/sandbox-base-image-promote.yml`, `.github/workflows/sandbox-base-image-rollback.yml`, `scripts/gcp/*`

- [x] Replace GKE assumptions with single-VM deploy docs and runbooks.
  - Acceptance criteria: deployment docs describe one VM runtime, system service ownership, TLS termination, and rollback path.
  - Files: `plans/phase-7-deployment.md`, `docs/operations/*`, `deploy/systemd/*`, `deploy/caddy/Caddyfile`, `scripts/deploy/*`

- [x] Add single-VM deploy + rollback automation in GitHub Actions.
  - Acceptance criteria: deploy workflow can publish and restart services on one VM with health checks; rollback workflow can restore previous release.
  - Files: `.github/workflows/deploy-single-vm.yml`, `.github/workflows/rollback-single-vm.yml`, `scripts/deploy/*`

- [x] Establish production env/secrets contract.
  - Acceptance criteria: required vars are documented and startup fails fast when missing.
  - Required examples: `API_CALLBACK_URL`, `SANDBOX_EXPECTED_RUNTIME_VERSION`, `GCE_IMAGE_PROJECT`, DB/auth/GCP settings.
  - Files: `src/config.ts`, `docs/operations/runtime-env.md`, `docs/operations/deploy-single-vm.md`

- [ ] Finalize database operations for production.
  - Acceptance criteria: migration, backup, and restore procedures are documented and tested.
  - Files: `docs/operations/database.md`, workflow or runbook scripts

- [ ] Add monitoring and alerting for API + sandbox lifecycle.
  - Acceptance criteria: alerts cover API health, reconciler failures, VM creation/start failures, and callback/auth failures.
  - Files: observability config/docs

## Machine Type Policy

- Machine profile changes are owner/admin controlled through agent settings (`machine_type`, optional accelerator profile), not approval popups.
- No runtime approval popup route is required for normal operation.
- Reconciler remains the only component mutating sandbox VM infrastructure.

## Open Issues

- Choose production DB connection mode (Cloud SQL Auth Proxy vs direct private IP).
- Decide deploy trigger strategy (`main` auto-deploy vs manual promotion job). Current default is manual (`workflow_dispatch`).

## GitHub Actions Prerequisites

- Repository variables:
  - `GCP_PROJECT_ID`
  - `GCP_ZONE`
  - Optional: `BASE_IMAGE_PROJECT`, `BASE_IMAGE_FAMILY`, `SANDBOX_BASE_IMAGE_PROJECT`, `SANDBOX_BASE_IMAGE_FAMILY`, `SANDBOX_IMAGE_FAMILY`
- Repository secrets:
  - Preferred: `GCP_SERVICE_ACCOUNT_KEY`
  - Optional WIF mode: `GCP_WORKLOAD_IDENTITY_PROVIDER` + `GCP_SERVICE_ACCOUNT`

## Decisions

- Use single control-plane VM deployment for current scale.
- Use Caddy as the production reverse proxy/TLS terminator.
- Keep sandbox image CI/CD and reconciler-based lifecycle as the production baseline.
