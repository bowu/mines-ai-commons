# Runtime Environment Contract (Single-VM Production)

This file defines required environment variables for `/opt/mines-ai/shared/.env`.
In CI/CD, this file is sourced from GitHub Environment secret `PROD_APP_ENV` each deploy.

## Identity Model
Preferred mode is VM-attached service account (no JSON key file on disk).

- Cloud SQL Auth Proxy authenticates using VM metadata identity.
- API GCP SDK calls also use VM metadata identity when `GCP_SERVICE_ACCOUNT_KEY` is unset.

Fallback mode is `GCP_SERVICE_ACCOUNT_KEY` JSON in env.

## Required Variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | Point to Cloud SQL proxy endpoint, e.g. `postgresql://user:pass@127.0.0.1:5432/db` |
| `CLOUD_SQL_INSTANCE_CONNECTION_NAME` | Yes | Format: `project:region:instance` |
| `SESSION_SECRET` | Yes | Long random value |
| `PUBLIC_URL` | Yes | Must be `https://mines-ai.com` in production (used for magic-link URLs) |
| `API_CALLBACK_URL` | Yes | Must be `https://mines-ai.com` in production |
| `VM_TOKEN_SECRET` | Yes | VM internal auth token secret |
| `VM_BOOTSTRAP_SECRET` | Yes | VM bootstrap endpoint secret |
| `GCP_PROJECT_ID` | Yes | Project ID hosting VMs and services |
| `GCP_ZONE` | Yes | Default zone for agent VMs |
| `VM_SERVICE_ACCOUNT_EMAIL` | Yes | Service account attached to agent VMs |
| `SANDBOX_MODE` | Yes | Must be `gce` |
| `LITELLM_PROXY_URL` | Yes | Public proxy base URL reachable from sandbox VMs, e.g. `https://mines-ai.com/litellm/v1` |
| `LITELLM_PROXY_API_KEY` | Yes | Shared key for control-plane and sandbox access to LiteLLM proxy |
| `LITELLM_MODEL_GEMINI` | Yes | Proxy alias for Gemini route (default `gemini-3.1-pro`) |
| `LITELLM_MODEL_SONNET` | Yes | Proxy alias for Sonnet route (default `sonnet-4.6`) |
| `LITELLM_MODEL_OPUS` | Yes | Proxy alias for Opus route (default `opus-4.6`) |
| `LITELLM_MODEL_GPT` | Yes | Proxy alias for GPT route (default `gpt-5.2`) |
| `GCE_IMAGE_PROJECT` | Yes | Sandbox image project |
| `AUTH_PROVIDER` | Yes | `none`, `oidc`, or `magic` |
| `AWS_ACCESS_KEY_ID` | Yes | Bedrock credentials used by LiteLLM Sonnet route |
| `AWS_SECRET_ACCESS_KEY` | Yes | Bedrock credentials used by LiteLLM Sonnet route |
| `AWS_REGION` | Yes | Bedrock region, e.g. `us-west-2` |
| `OPENAI_API_KEY` | Yes (if GPT enabled) | OpenAI key used by LiteLLM GPT route |

## Required image selector (at least one)
- `GCE_IMAGE_FAMILY`
- `SANDBOX_EXPECTED_RUNTIME_VERSION`

At least one of these must be set. If both are set, runtime version selection can be used while family remains as fallback/compatibility.

## Conditional Required (OIDC)
Required when `AUTH_PROVIDER=oidc`:

- `OIDC_ISSUER_URL`
- `OIDC_CLIENT_ID`
- `OIDC_CLIENT_SECRET`
- `OIDC_CALLBACK_URL`

## Conditional Required (Magic Link)
Required when `AUTH_PROVIDER=magic`:

- `SENDGRID_API_KEY`
- `AUTH_MAGIC_FROM_EMAIL`

Optional when `AUTH_PROVIDER=magic`:

- `AUTH_MAGIC_LINK_SECRET` (falls back to `SESSION_SECRET` if unset)
- `AUTH_MAGIC_LINK_TTL_MS` (defaults to 10 minutes)
- `AUTH_MAGIC_RESEND_COOLDOWN_MS` (defaults to 30 seconds; prevents duplicate sends)

## Optional (fallback identity)
| Variable | Required | Notes |
|---|---|---|
| `GCP_SERVICE_ACCOUNT_KEY` | Optional | JSON key fallback; leave unset when using VM-attached identity |

## Explicitly Not Used In Production
- `CLOUDFLARED_TUNNEL_TOKEN` (dev only)
- quick tunnel callback generation scripts

## Validation
Run before every deploy:

```bash
sudo ./scripts/deploy/validate-env.sh --env-file /opt/mines-ai/shared/.env
```

The script fails fast and names every missing variable explicitly.

## Local `.env` to Production Secret Sync Overrides
If you use `scripts/secrets/sync-production-env-from-dotenv.sh`, you can keep local dev values and override production values:

- `PROD_DATABASE_URL` -> emitted as `DATABASE_URL`
- `PROD_PUBLIC_URL` -> emitted as `PUBLIC_URL`

## CI Deploy Access
For GitHub Actions SSH deploy, configure bootstrap with `--deploy-user <ssh-user>`.
Bootstrap installs a scoped sudoers rule for that user, limited to:
- `/opt/mines-ai/scripts/deploy/install-release.sh`
- `/opt/mines-ai/scripts/deploy/smoke-check.sh`
- `/opt/mines-ai/scripts/deploy/rollback-single-vm.sh`
