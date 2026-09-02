---
doc: forge-mcp implementation plan
type: plan
status: active
summary: The clean-room build of forge-mcp — an MCP server exposing Laravel Forge through twelve curated tools on the organization-scoped Forge API, sequenced in four stages.
keywords: [mcp, laravel-forge, api, typescript, tools, deployment, organization-scoped, stdio]
level: planning
created: 2026-09-02
updated: 2026-09-02
---

# forge-mcp — implementation plan

## Why this exists

Laravel Forge discontinued API v1 on **2026-08-31**. Every integration built against
`https://forge.laravel.com/api/v1` now receives `404` and the HTML application shell instead of
JSON — the routes are gone, not merely deprecated. The replacement API lives at
`https://forge.laravel.com/api` and is **organization-scoped**: 141 of its 159 paths sit under
`/orgs/{organization}/…`, a segment that had no equivalent in v1.

That is not a base-URL change. Resource addressing, the deployment-state verbs and the
quick-deploy concept all moved, so this is a new implementation rather than a migration.

## Scope

Twelve tools. Deliberately narrow: the API exposes 159 paths, and a server that surfaces all of
them floods an agent's context and makes tool selection worse, not better. Breadth is a later
decision, taken on evidence once these twelve are proven.

| Tool | Endpoint | Kind |
|---|---|---|
| `list_servers` | `GET /orgs/{org}/servers` | read |
| `get_server` | `GET /orgs/{org}/servers/{server}` | read |
| `get_server_status` | derived from `ServerResource` health fields | read |
| `list_sites` | `GET /orgs/{org}/servers/{server}/sites` | read |
| `get_site` | `GET /orgs/{org}/sites/{site}` | read |
| `get_deployments` | `GET /orgs/{org}/servers/{server}/sites/{site}/deployments` | read |
| `get_deployment_script` | `GET …/deployments/script` | read |
| `deploy_site` | `POST …/deployments` | write |
| `update_deployment_script` | `PUT …/deployments/script` | write |
| `set_push_to_deploy` | `POST` / `DELETE …/deployments/push-to-deploy` | write |
| `reset_deployment_state` | `DELETE …/deployments/status` | write |
| `reboot_server` | `POST …/servers/{server}/actions` `{"action":"reboot"}` | write |

### Three tools that could not be carried across unchanged

- **Server load has no successor.** `ServerResource` carries no CPU, memory or load-average
  field, and `monitors` are *alerting thresholds* (`cpu_load` + threshold + notify address), not a
  metrics read. Nothing in the API returns a current reading. `get_server_status` replaces it,
  returning what does exist: `connection_status`, `is_ready`, `db_status`, `redis_status`,
  `opcache_status`, `php_version`. It answers "is this server healthy?" without inventing a number.
- **Quick deploy became push-to-deploy**, and stopped being a boolean. It is now a subresource
  created with `POST` and removed with `DELETE`, so `set_push_to_deploy` takes an explicit
  `enabled` argument rather than toggling unseen state.
- **Reboot is no longer a verb.** It is one value of a generic server action endpoint, which also
  accepts `power-cycle`. Only `reboot` is exposed; power-cycling a server is not something an
  agent should reach by accident.

## Architecture

Modules are split so that adding a tool never touches transport, auth or org resolution.

```
src/index.ts        entry — stdio transport wiring only
src/client.ts       ForgeClient: auth, base URL, request, pagination
src/org.ts          lazy organization resolver (cache + FORGE_ORG override)
src/errors.ts       HTTP status → actionable error; never echoes the token
src/types.ts        narrow hand-written types for the twelve responses
src/tools/servers.ts · sites.ts · deployments.ts
src/tools/index.ts  registry: name → { schema, annotations, handler }
```

**Stack**: TypeScript (strict), Node >= 20, ESM, `@modelcontextprotocol/sdk` 1.x, Zod input
schemas, vitest. Transport is stdio, so there are no ports.

## Decisions and why

**Organization resolution is lazy, not eager.** The first tool call issues `GET /orgs` and caches
the result for the process lifetime. Exactly one organization is used silently, so the common case
needs no configuration beyond the API token. More than one, with no `FORGE_ORG` set, fails with an
error naming the available slugs. Resolving during `initialize` was rejected: it makes a Forge
outage block the MCP handshake, so the server would fail to connect at all rather than fail one
call with a clear message.

**Read and write are machine-readable, not a naming convention.** Every tool carries MCP
annotations (`readOnlyHint`, `destructiveHint`). Five of the twelve mutate production
infrastructure — deploying, rebooting, rewriting a deployment script — and the only thing
separating a staging server from a production one is a numeric id. Annotations let any client gate
those tools without maintaining a hand-written allow-list that silently rots as tools are added.

**Errors are actionable and never leak the credential.** `401` reports an invalid or expired
token; `403` names the missing scope; `404` distinguishes an unknown organization from an unknown
resource; `422` surfaces field errors; `429` reports retry-after. The token is excluded from every
error, log line and message — an integration that echoes its own credential into a transcript
turns one mistake into a disclosure.

**No code generation from the OpenAPI document.** Generated tool descriptions are written for
humans reading reference documentation, not for a model choosing between twelve options. The
descriptions are the interface here, so they are written by hand.

## Build order

Four stages. Each ends at something demonstrable rather than at a layer boundary, so a failure
surfaces against the real API early.

1. **Walking skeleton** — `package.json`, `tsconfig`, build, stdio wiring, `ForgeClient`, lazy org
   resolution, and three read tools (`list_servers`, `get_server`, `list_sites`). Done when a real
   MCP client lists the tools and `list_servers` returns live servers from a real account.
2. **Remaining read tools** — `get_site`, `get_server_status`, `get_deployments`,
   `get_deployment_script`. Done when every read path is covered by a test against recorded
   fixtures.
3. **Write tools** — the five mutating tools, each with annotations. Done when annotations are
   present and asserted in tests, and no test performs a real mutation.
4. **Release** — README, usage documentation, npm publish. Done when a clean machine can install
   and connect using the published package and a token alone.

## Testing

Vitest, with `fetch` mocked against fixtures captured read-only from the live API. One opt-in
integration smoke test behind an environment flag, restricted to read-only calls: **no test ever
deploys, reboots or rewrites a script.** A test suite that can mutate production is a test suite
nobody dares run.

## Open questions

- `DELETE …/deployments/status` is documented as *"Update deployment state"*. The verb and the
  summary disagree; behaviour is to be confirmed against a real site before `reset_deployment_state`
  is wired, in stage 3.
- Package name: `forge-mcp` is taken on npm by an unrelated package, so a scope is likely needed.
  Decided at stage 4, not before.

## Non-goals

Server or site provisioning, DNS and certificate management, database administration, and the
Laravel integration endpoints (Horizon, Octane, Pulse, Reverb). All are reachable in the API and
none are in this scope. Adding them is a separate decision with its own evidence.
