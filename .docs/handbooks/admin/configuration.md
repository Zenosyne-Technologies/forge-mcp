---
doc: Configuring forge-mcp
type: handbook
status: active
summary: The environment variables forge-mcp reads, what happens with one Forge organization versus several, and what to do about each organization-resolution error message.
keywords: [configuration, forge-org, forge-api-key, environment, organization, troubleshooting]
level: project
audience: admin
module: configuration
sources:
  - src/org.ts
  - src/client.ts
related:
  - "[[organization-resolution]]"
  - "[[error-messages]]"
created: 2026-09-02
updated: 2026-09-02
---

# Configuring forge-mcp

## Environment variables

`FORGE_API_KEY` is required. `FORGE_ORG` is optional and only matters if your token can see more than one Forge organization.

## What happens on the first tool call

forge-mcp does not check which organization it will act on until the first tool is actually called — not when it starts up. That is deliberate: checking at startup would mean a Forge outage keeps the server from connecting at all; checking lazily means it connects normally, and at worst one tool call fails with a message explaining why.

- **Your token sees exactly one organization** — nothing to configure. It is picked automatically and silently, every time, for the life of the running server.
- **Your token sees more than one, and `FORGE_ORG` is not set** — the first tool call fails with a list of the organization slugs your token can see (up to 10, plus a count of any more). Set `FORGE_ORG` to the one you want and restart the server.
- **`FORGE_ORG` is set** — it is used as-is (after trimming surrounding whitespace); no lookup happens at all. A blank value is treated the same as not setting it.

Once the server has answered this question, it does not ask Forge again for the rest of that run. Restart the process to make it re-check — for example, after your token's organization access has changed.

## Error messages and what to do

| You see | What it means | What to do |
|---|---|---|
| `FORGE_ORG is not a usable organization slug...` | The value contains something other than letters, digits, `.`, `_`, `-` — a slash or a `..` segment, typically | Fix the value in your environment; it is never echoed back into the message |
| `Forge rejected the API token (401)...` | `FORGE_API_KEY` is missing, invalid, or expired | Issue a new token in your Forge API settings, set `FORGE_API_KEY`, restart |
| `Forge refused this server's organization lookup (403)...` | The token is valid but lacks the scope to list organizations | Grant it organization access, or set `FORGE_ORG` directly, then restart |
| `This Forge token can see no organizations...` | There is nothing for the server to point itself at | Add the token to an organization in Forge |
| `This token can see N organizations...` | More than one is visible and `FORGE_ORG` is not set | Set `FORGE_ORG` to one of the listed slugs, restart |
| `Forge's response to GET /orgs did not...` | Forge returned a shape this server does not recognize | Set `FORGE_ORG` directly to bypass the lookup |

Every one of these is permanent for the life of the running process — the server does not retry the same question on its own, so a restart is what makes it try again after the underlying cause is fixed. A plain network error, or a `429`/`5xx` from Forge, is different: those are retried automatically on the next tool call, no restart needed.

## Request timeout

Every Forge API request is capped at 30 seconds. If Forge itself hangs, forge-mcp reports a failed call rather than hanging indefinitely — there is nothing to configure here.

## See also

[[organization-resolution]] for how this works internally. [[error-messages]] for what it means when a failed tool call quotes text Forge itself reported.
