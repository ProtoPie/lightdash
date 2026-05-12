# Local Run and Okta MCP Auth

This note tracks the implementation slice started in the Lightdash fork.

## Local run target

Use the normal Lightdash developer flow:

1. Install dependencies with `pnpm install`.
2. Start Postgres, MinIO, NATS, and browser dependency services with the existing Docker/dev scripts.
3. Run backend migrations so the Protopie tables are created.
4. Run `pnpm generate-api` after TSOA controller changes.
5. Start backend and frontend with the repo `dev` scripts.

Initial local blockers found on this machine:

- `pnpm` was not installed or activated by Corepack.
- Corepack failed signature verification for the requested pnpm package.
- Docker socket access required escalation from the sandbox.

Resolved local state:

- pnpm 10.33.0 is installed globally, matching this repo's `packageManager`.
- Local Docker dependency services are running from `.env.development`.
- Backend migrations have run, including the Protopie migration directory.

Once those are available, validate:

- `GET /api/v1/projects/:projectUuid/protopie/forms/schemas`
- `POST /api/v1/projects/:projectUuid/protopie/forms/churn_score_input/submissions`
- `/projects/:projectUuid/protopie/forms` in the frontend.
- MCP tool list includes `protopie_*` read and write tools.

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
- Actual dashboard/chart writes still go through `CoderService`, so Lightdash content-as-code permissions remain enforced.
