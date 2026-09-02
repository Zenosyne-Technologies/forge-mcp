# forge-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
[Laravel Forge](https://forge.laravel.com) to AI agents — servers, sites and deployments, through
twelve curated tools.

> **Status: in development.** The project scaffolding and design are in place; the tools are being
> implemented. It is not yet published to npm and is not yet usable. See
> [the implementation plan](.docs/plans/forge-mcp-implementation.md) for the build order.

## Why this exists

Laravel Forge discontinued **API v1 on 2026-08-31**. Integrations pointed at
`https://forge.laravel.com/api/v1` now receive `404` and the Forge application shell rather than
JSON — the routes were removed, not deprecated in place.

The current API lives at `https://forge.laravel.com/api` and is **organization-scoped**: 141 of its
159 paths sit under `/orgs/{organization}/…`, a segment v1 had no equivalent for. Resource
addressing, the deployment-state verbs and the quick-deploy concept all moved, so this is a fresh
implementation written against the current API rather than a port of an older one.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `FORGE_API_KEY` | yes | A Forge API token from [your API settings](https://forge.laravel.com/profile/api) |
| `FORGE_ORG` | only if you belong to more than one organization | Organization slug, e.g. `acme-ltd` |

If your token sees exactly one organization, it is resolved automatically on the first tool call
and `FORGE_ORG` is unnecessary. With more than one and no `FORGE_ORG` set, the server fails with an
error naming the slugs available to you.

Your token is read from the environment and is never written to logs, error messages or tool
output.

## Tools

Seven read tools:

| Tool | What it does |
|---|---|
| `list_servers` | List the organization's servers |
| `get_server` | Full detail for one server |
| `get_server_status` | Health of one server — connection, database, Redis, OPcache, readiness |
| `list_sites` | List the sites on a server |
| `get_site` | Full detail for one site |
| `get_deployments` | Deployment history for a site |
| `get_deployment_script` | The current deployment script for a site |

Five write tools, which **change production infrastructure**:

| Tool | What it does |
|---|---|
| `deploy_site` | Trigger a deployment |
| `update_deployment_script` | Replace a site's deployment script |
| `set_push_to_deploy` | Enable or disable push-to-deploy |
| `reset_deployment_state` | Clear a stuck deployment state |
| `reboot_server` | Reboot a server |

Every tool declares MCP annotations (`readOnlyHint`, `destructiveHint`), so a client can require
confirmation for the write tools without maintaining its own list. This matters more than it may
appear: these tools address infrastructure by numeric id, and nothing distinguishes a staging
server from a production one except the number.

### Tools you will not find here

Forge no longer reports server load — `ServerResource` carries no CPU, memory or load-average
field, and monitors are alerting thresholds rather than a metrics read. `get_server_status` returns
the health fields that do exist instead of inventing a number.

Provisioning, DNS, certificates, database administration and the Laravel integration endpoints
(Horizon, Octane, Pulse, Reverb) are all reachable in the API and deliberately out of scope. A
server that surfaces all 159 paths makes an agent's tool selection worse, not better.

## Development

```bash
npm install
npm run build      # tsc
npm run dev        # tsx src/index.ts
npm test           # vitest
```

Requires Node 20 or newer. The server speaks MCP over stdio, so there are no ports to bind.

Tests run against recorded fixtures with `fetch` mocked. The opt-in integration suite makes
read-only calls only — no test deploys, reboots or rewrites a script.

## License

MIT — see [LICENSE](LICENSE).
