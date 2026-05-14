# 16 — Local Run and Okta MCP Auth

This note tracks how to run the fork locally and how MCP clients authenticate against local, dev, and prod-style Lightdash.

## Local run target

Use the normal Lightdash developer flow:

1. Install dependencies with `pnpm install`.
2. Start Postgres, MinIO, NATS, and browser dependency services with the existing Docker/dev scripts.
3. Run backend migrations so the Protopie tables are created.
4. Run `pnpm generate-api` after TSOA controller changes.
5. Start backend and frontend with the repo dev scripts.

Local MCP/dbt env:

```bash
MCP_ENABLED=true
PROTOPIE_DBT_LOCAL_PATH=/Users/mamur/Documents/projects/data-modeling
PROTOPIE_DBT_ALLOWED_PATHS=models,marts,macros,seeds,snapshots,analyses,analysis,tests,dbt_project.yml,packages.yml,selectors.yml,exposures.yml,README.md
```

Once the app is running, validate:

- `GET /api/v1/projects/:projectUuid/protopie/forms/schemas`
- `POST /api/v1/projects/:projectUuid/protopie/forms/churn_score_input/submissions`
- `/projects/:projectUuid/protopie/forms` in the frontend
- `/api/v1/mcp` returns an OAuth/auth challenge, not 404
- MCP tool list includes `protopie_get_overview`, `protopie_dbt_*`, `lightdash_api_*`, and `protopie_upsert_*`

## Codex MCP setup

Local:

```bash
codex mcp add lightdash --url http://localhost:3000/api/v1/mcp
codex mcp login lightdash --scopes read,write,mcp:read,mcp:write
```

Dev:

```bash
codex mcp add lightdash-mcp --url https://lightdash-dev.protopie.io/api/v1/mcp
codex mcp login lightdash-mcp --scopes read,write,mcp:read,mcp:write
```

After login, restart the Codex session so tool discovery runs again. A successful MCP connection should expose Lightdash tools in the session; a reachable endpoint that still shows `401 Unauthorized` before OAuth is normal.

If Codex reports `Deserialize error: data did not match any variant of untagged enum JsonRpcMessage`, check that the configured MCP URL points to `/api/v1/mcp` on the same Lightdash host that is serving OAuth discovery, then remove and re-add the MCP server:

```bash
codex mcp remove lightdash-mcp
codex mcp add lightdash-mcp --url https://lightdash-dev.protopie.io/api/v1/mcp
codex mcp login lightdash-mcp --scopes read,write,mcp:read,mcp:write
```

## Claude setup

Claude Desktop can use the same MCP HTTP endpoint:

```text
https://lightdash-dev.protopie.io/api/v1/mcp
```

In Claude, add a remote MCP connector/server named `lightdash-mcp`, use the Lightdash MCP URL, then complete the OAuth browser flow. Request `read`, `write`, `mcp:read`, and `mcp:write` scopes when the client supports explicit scopes.

## Production Okta auth path

Do not build a separate Okta implementation for MCP. Lightdash already has Okta login and OAuth-based MCP auth.

Set the existing Okta env vars in production:

- `AUTH_OKTA_OAUTH_ISSUER`
- `AUTH_OKTA_OAUTH_CLIENT_ID`
- `AUTH_OKTA_OAUTH_CLIENT_SECRET`
- `AUTH_OKTA_AUTHORIZATION_SERVER_ID`
- `AUTH_OKTA_EXTRA_SCOPES`
- `AUTH_OKTA_DOMAIN`

Okta routes already used by Lightdash:

- Login: `/login/okta`
- Callback: `/oauth/redirect/okta`

MCP clients should use Lightdash's OAuth discovery and dynamic client registration. The user signs in to Lightdash through Okta during the authorize step, and the resulting OAuth access token carries MCP scopes.

Required write controls:

- Token scope must include `mcp:write`.
- The organization must explicitly enable MCP writes with `PATCH /api/v1/protopie/mcp-settings`.
- The admin UI for the toggle is at `/generalSettings/integrations` under Protopie MCP.
- Actual dashboard/chart writes still go through `CoderService`, so Lightdash content-as-code permissions remain enforced.

## dbt source access in dev/prod MCP

Dev/prod MCP gets data-modeling knowledge from GitHub:

```bash
PROTOPIE_DBT_GITHUB_OWNER=ProtoPie
PROTOPIE_DBT_GITHUB_REPO=data-modeling
PROTOPIE_DBT_GITHUB_REF=main
PROTOPIE_DBT_GITHUB_TOKEN=<fine-grained-read-only-pat>
```

Use a fine-grained GitHub PAT with read-only access to `ProtoPie/data-modeling`: Metadata read-only and Contents read-only. This gives MCP dbt context without granting the Codex or Claude client separate GitHub access.
