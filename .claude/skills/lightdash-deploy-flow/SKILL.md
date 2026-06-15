---
name: lightdash-deploy-flow
description: Use when deploying the Lightdash fork or editing the Makefile/infra — clarifies that DEV deploys via `make deploy-dev` from the in-repo infra/, that terraform apply is forbidden until `terraform plan` shows no destroys, and that PROD must never be deployed from these targets.
---

# Lightdash fork — deploy flow

## Environment map

| Environment | Image | Infra source of truth | Deploy command |
|---|---|---|---|
| **dev** | custom ECR `protopie/lightdash:dev-<sha>` | in-repo `infra/dev/` | `make deploy-dev` |
| **prod** | upstream `lightdash/lightdash` (NOT the fork yet) | `lightdash_Infra/infra/prod` (separate repo) | **disabled — do not deploy** |

Account `750128304405`, region `us-west-2`, profile `xid-prod`. dev + prod share the
S3 backend bucket `xid-prod-terraform` (keys `lightdash-dev` / `lightdash-prod`).

## Branch & release model — trunk-based

This is a **fork** (`github.com/ProtoPie/lightdash`). We use **trunk-based** git, NOT
environment branches (no `develop`).

- **`main` is the trunk** = the known-good, production-ready state.
- **Feature branches** (`protopie/*`, `feat/*`) are cut from `main`, then merged back
  via PR. Keep them short-lived.
- **dev deploys are decoupled from branches.** `make deploy-dev` builds + pushes an
  image tagged by git sha (`dev-<sha>`), so you can deploy ANY branch/commit to dev for
  testing. The branch does not gate the dev deploy.
- **prod (after cutover) deploys only from a tagged commit on `main`.** Cut a git tag
  (e.g. `git tag prod-2026.06.15 && git push origin prod-2026.06.15`) to mark exactly
  what is on prod. There is no long-lived prod branch — the tag is the record.
- **Image tags ≠ git tags.** The Makefile tags images `dev-<sha>` / `prod-<sha>`; git
  release tags mark the prod-blessed commit. They reference the same sha.

When CI is added later, the trigger maps to this model: PR merge to `main` builds a
candidate; a pushed release tag (or manual dispatch) is what promotes to prod. No
`develop` is introduced.

### Upstream sync (fork maintenance)

To pull updates from the original Lightdash, keep an `upstream` remote:

```bash
git remote add upstream https://github.com/lightdash/lightdash.git   # one-time
git fetch upstream
git switch -c sync/upstream-$(date +%Y%m%d) main
git merge upstream/main    # resolve conflicts, then PR sync/* -> main
```

Never deploy a sync branch to prod without dev verification first.

## DEV: the one command

```bash
make deploy-dev    # build image -> push to ECR -> terraform plan -> (confirm) -> apply
```

Other dev targets:
- `make build-dev` — build + push only (no infra change)
- `make plan-dev` — terraform plan only (read-only)
- `make deploy-dev-quick` — restart current image (force-new-deployment), no rebuild
- `make logs-dev` — tail dev CloudWatch logs
- `make health-dev DEV_SITE_URL=https://lightdash-dev.protopie.io`
- `SKIP_PREFLIGHT=1` — skip backend typecheck on a clean checkout

## Hard rules

1. **Never run `terraform apply` until `terraform plan` is clean.** `make deploy-dev`
   always shows the plan and requires you to type `yes` first. If the plan shows it
   would destroy/replace a resource (e.g. the **browserless sidecar** or the **RDS
   instance**), STOP and report — do not apply. Live dev runs lightdash + browserless;
   a plan that removes browserless means infra drifted.
2. **Never deploy prod from this repo.** `make deploy-prod` is intentionally disabled.
   Prod still runs the stock upstream image; cutover needs a reconciled `infra/prod`
   and explicit human approval (out of scope for routine dev work).
3. **Build is local + heavy.** The Vite frontend build can OOM (exit 137) if other
   containers are running. `build-dev` warns via `docker-mem-check`; `docker stop`
   heavy stacks (e.g. local airflow) before building if warned.
4. **RDS has deletion protection OFF** on both dev and prod (known gap). Be extra
   careful that no plan forces an RDS replacement.

## Why in-repo infra is the source of truth

`infra/dev/` was reconciled to byte-match the live dev definition (previously kept in
the separate `lightdash_Infra` repo). The Makefile's `INFRA_ROOT` points at in-repo
`infra/`, so `make deploy-dev` operates on the same definition that produced live dev.
`lightdash_Infra` will be deprecated after the prod cutover.

## Account identity / secrets

Secrets come from SSM Parameter Store `/lightdash/<env>/*` (injected into the ECS task
via the task definition `secrets[]`), not from `.env`. The `.env` in each infra dir
carries non-secret config only and is gitignored. Run `lightdash_Infra/scripts/pull-secrets.sh`
to refresh local `.env`. Never commit any `.env`.
