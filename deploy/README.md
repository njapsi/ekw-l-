# deploy/

Production deployment assets. The step-by-step runbook is **`docs/DEPLOYMENT.md`**;
this folder holds the files it references.

| File                               | Purpose                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `../Dockerfile.web`                | Next.js standalone image (non-root, `HEALTHCHECK` on `/api/health`)                                                 |
| `../Dockerfile.worker`             | BullMQ worker image + Playwright Chromium (`HEALTHCHECK` on `/healthz`)                                             |
| `../.dockerignore`                 | keeps the build context lean; **never** ships `.env*`                                                               |
| `../docker-compose.production.yml` | single-host stack: `web` + `worker` + `caddy` + one-shot `migrate`; external managed Postgres/Redis/S3              |
| `Caddyfile`                        | TLS termination (auto Let's Encrypt), canonical-host redirect, `Cache-Control` for `/_next/static`                  |
| `prometheus.yml`                   | scrape config for `web:/api/metrics` (bearer `METRICS_TOKEN`) + `worker:/metrics`                                   |
| `alerts.yml`                       | Prometheus alerting rules (availability, error rate, latency, integration failures, AI spend, job/crawler failures) |
| `backup/pg-backup.sh`              | `pg_dump -Fc` → gzip/gpg → object storage, with retention pruning                                                   |
| `backup/pg-restore.sh`             | download + checksum + `pg_restore` into a **scratch** DB (test quarterly)                                           |
| `../scripts/check-env.mjs`         | pre-deploy env validation — fails the release if a required var is missing/invalid, **never prints a secret value** |

## Quick reference

```bash
# 1. validate the target environment (no secrets printed)
node scripts/check-env.mjs --file .env.production --target all

# 2. build images
IMAGE_TAG=$(git rev-parse --short HEAD) \
  docker compose -f docker-compose.production.yml build

# 3. run migrations as a release step (never at container boot)
docker compose -f docker-compose.production.yml run --rm migrate

# 4. roll out
IMAGE_TAG=$(git rev-parse --short HEAD) \
  docker compose -f docker-compose.production.yml up -d

# 5. smoke test
curl -fsS https://$APP_DOMAIN/api/health | jq .status      # ok | degraded
docker compose -f docker-compose.production.yml exec worker \
  wget -qO- http://127.0.0.1:9090/healthz
```

## Platform note

`docker-compose.production.yml` targets a **single self-managed host**. On
Fly.io / Render / ECS / k8s, use the two Dockerfiles directly as separate
services, provide the same env, run `migrate:deploy` in a release/pre-deploy
hook, and use the platform's own health-check + autoscaling instead of Caddy +
compose. `docs/DEPLOYMENT.md` covers both.
