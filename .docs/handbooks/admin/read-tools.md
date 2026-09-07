---
doc: Using the read-only tools
type: handbook
status: active
summary: What list_servers, get_server, get_server_status, list_sites and get_site return, how to page through results with cursor and page_size, what the read-only annotations mean for an agent client, which fields and which related records never appear on purpose, and why a name or domain can render slightly differently than it does in the Forge dashboard.
keywords: [list_servers, get_server, get_server_status, list_sites, get_site, pagination, cursor, page_size, has_more, next_cursor, annotations, readOnlyHint, emoji, invisible characters, server health, CPU, load average]
level: project
audience: admin
module: read tools
sources:
  - src/tools/servers.ts
  - src/tools/sites.ts
  - src/tools/common.ts
  - src/upstream-text.ts
related:
  - "[[configuration]]"
  - "[[error-messages]]"
created: 2026-09-03
updated: 2026-09-07
---

# Using the read-only tools

## The five tools

- **`list_servers`** — every Forge server in your organization, one page per call: id, name, provider, region, both IP addresses, SSH port, PHP versions, database type, timezone, readiness and connection status, and database/Redis/OPcache status.
- **`get_server`** — the same information for one server you already have an id for. It returns exactly what `list_servers` returns for that server, nothing more — reach for it when you already hold an id, and for `list_servers` when you need to find one or see several at once.
- **`get_server_status`** — a shorter health-only answer for one server: is it connected, is it ready, and is the database, Redis and OPcache each up — plus the PHP version running there. It is the same seven values `get_server` already includes, never more; reach for it when the only question is "is this server healthy?" and the rest of `get_server`'s fields would be unused. **Forge does not report CPU, memory or load-average figures at all**, so this tool — and no other tool here — can answer a "how loaded is this server?" question; "healthy" here means connected and ready, not "under light load."
- **`list_sites`** — the sites on one server, one page per call: id, domain, URL, app type, repository provider/branch, and deployment status. Get the server id from `list_servers` first.
- **`get_site`** — one site by its own site id, with no server id needed. Use it when you hold a site id and don't know (or don't need to know) which server hosts it; it returns exactly what `list_sites` returns for that site, nothing more.

All five only read. None can change a server, deploy a site, or touch a deployment script.

## What the annotations mean for your client

Every one of these five tools is marked `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`. An MCP client that gates tool calls — auto-approving safe ones, asking before a risky one, deciding whether a retry after a timeout is safe — reads these flags rather than needing a hand-maintained list of which forge-mcp tools are safe. If your client supports policy based on these annotations, these five (and only these five, at this stage of the project) qualify for the least-restrictive tier: calling one twice in a row is exactly as safe as calling it once, and nothing about your Forge account changes as a result.

## Paging through results

`list_servers` and `list_sites` both return a page at a time, using two arguments:

- **`page_size`** — how many rows you want, 1 to 100 (default 50).
- **`cursor`** — omit it for the first page; pass back the previous call's `next_cursor` to get the next one.

Every page also carries:

- **`count`** — how many rows are actually in this page.
- **`next_cursor`** — pass this back as `cursor` to continue. If it is `null`, there either is no more data, or more data exists but cannot currently be reached (see below — `notes` will say which).
- **`has_more`** — `true` means more rows exist somewhere beyond this page.
- **`notes`** — plain-language warnings about this specific page. Empty on an ordinary page; read it whenever it is not.

The one combination worth knowing by name: **`has_more: true` with `next_cursor: null`.** This means more rows exist but there is currently no way to ask for them — treat the page you have as incomplete, not as the whole list. `notes` always spells this out rather than leaving it to be inferred from the two fields together. Nothing is ever dropped silently: if a page had to be cut short for any reason, `notes` says so and says how many rows were affected.

## What you will never see in a tool result

By design, no read tool ever returns: server credential material, the deploy-trigger URL for a site (a secret — anyone holding it can trigger a deployment), the raw deployment script, or shared-path link targets. This is not an oversight to work around; it is the same withholding principle [[error-messages]] describes for the `[redacted]` token substitution — data that would let an agent (or anyone reading its output) act destructively is kept out of read results entirely, not merely warned about.

`get_site` withholds something further: Forge's own answer for one site also carries a bundle of *related* records alongside it — the server that hosts the site (including its credential key material), any tags, recent deployments, and firewall/redirect rules. None of that bundle is returned, at all — not summarised, not partially. `get_site` gives you the one site record and nothing else attached to it; use `list_servers`/`get_server`, or the relevant future tool, for anything about the site's server, tags, deployments or rules.

Every successful result also opens with a standing `data_notice` field. That is not an error indicator — it appears on every normal result and exists to tell whatever is reading the output that the record values that follow (a server name, a site domain, a git branch) were written by whoever administers your Forge account, not by this server, and should not be treated as instructions.

## Why a name or domain can look slightly different than in the Forge dashboard

Every piece of text these tools copy from your account — a server name, a site domain, an alias, a git branch — passes through the same visible-text rule [[error-messages]] describes for a quoted Forge error, before it reaches the agent. In practice that can mean:

- A character that renders as nothing (an invisible formatting character some tool or paste added) is silently removed, rather than shown as a gap.
- Anything else out of the ordinary — an exotic space, an unassigned character — comes through as a single plain space.
- An emoji built from several joined characters (a family, a flag) can arrive as its separate parts, and a colour emoji can arrive as its plain black-and-white outline.
- Accented letters, and the combining marks used by scripts such as Devanagari, Thai and Arabic, are kept and continue to render correctly — a name in one of these scripts is not affected.

Nothing in Forge itself changes, and nothing is renamed — this only affects what forge-mcp is willing to repeat into an AI agent's context, for the reason [[error-messages]] gives for redaction: text written by someone else must not be able to carry hidden instructions or unreadable characters into what the agent reads. If a name looks off, the Forge dashboard always shows the real, unmodified value.

## See also

[[configuration]] for the environment variables that determine which organization these tools act against, and [[error-messages]] for what it means when a failed call — for example, `get_server` with an id that doesn't exist — quotes text Forge itself reported.
