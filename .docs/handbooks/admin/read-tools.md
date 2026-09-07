---
doc: Using the read-only tools
type: handbook
status: active
summary: What list_servers, get_server, get_server_status, list_sites, get_site, get_deployments and get_deployment_script return, how to page through results with cursor and page_size, what the read-only annotations mean for an agent client, which fields and related records never appear on purpose, why a name or domain can render slightly differently than in the Forge dashboard, and how to tell when a shown deployment script is not byte-for-byte what Forge has stored.
keywords: [list_servers, get_server, get_server_status, list_sites, get_site, get_deployments, get_deployment_script, pagination, cursor, page_size, has_more, next_cursor, annotations, readOnlyHint, emoji, invisible characters, server health, CPU, load average, deployment history, deployment script, auto_source, altered, truncated, byte-identical]
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

## The seven tools

- **`list_servers`** — every Forge server in your organization, one page per call: id, name, provider, region, both IP addresses, SSH port, PHP versions, database type, timezone, readiness and connection status, and database/Redis/OPcache status.
- **`get_server`** — the same information for one server you already have an id for. It returns exactly what `list_servers` returns for that server, nothing more — reach for it when you already hold an id, and for `list_servers` when you need to find one or see several at once.
- **`get_server_status`** — a shorter health-only answer for one server: is it connected, is it ready, and is the database, Redis and OPcache each up — plus the PHP version running there. It is the same seven values `get_server` already includes, never more; reach for it when the only question is "is this server healthy?" and the rest of `get_server`'s fields would be unused. **Forge does not report CPU, memory or load-average figures at all**, so this tool — and no other tool here — can answer a "how loaded is this server?" question; "healthy" here means connected and ready, not "under light load."
- **`list_sites`** — the sites on one server, one page per call: id, domain, URL, app type, repository provider/branch, and deployment status. Get the server id from `list_servers` first.
- **`get_site`** — one site by its own site id, with no server id needed. Use it when you hold a site id and don't know (or don't need to know) which server hosts it; it returns exactly what `list_sites` returns for that site, nothing more.
- **`get_deployments`** — the deployment history for one site, newest first, one page per call: each entry's status (`queued`, `deploying`, `finished`, `failed`, `failed-build`, `cancelled`, `pending`), what triggered it, the commit that shipped (hash, message, author, branch), and when it started and ended. Needs both a server id and a site id. Use it for "did the last deploy work" or "which commit is live."
- **`get_deployment_script`** — the shell script Forge will run the next time this site deploys, plus whether the site's `.env` is loaded first (`auto_source`). This is the one tool whose result keeps its line breaks, blank lines and spacing — see below for why, and for how to tell whether what you're shown is exactly what Forge has stored.

All seven only read. None can change a server, deploy a site, or touch a deployment script.

## What the annotations mean for your client

Every one of these seven tools is marked `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`. An MCP client that gates tool calls — auto-approving safe ones, asking before a risky one, deciding whether a retry after a timeout is safe — reads these flags rather than needing a hand-maintained list of which forge-mcp tools are safe. If your client supports policy based on these annotations, these seven (and only these seven, at this stage of the project) qualify for the least-restrictive tier: calling one twice in a row is exactly as safe as calling it once, and nothing about your Forge account changes as a result.

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

By design, no read tool ever returns: server credential material, the deploy-trigger URL for a site (a secret — anyone holding it can trigger a deployment), or shared-path link targets. This is not an oversight to work around; it is the same withholding principle [[error-messages]] describes for the `[redacted]` token substitution — data that would let an agent (or anyone reading its output) act destructively is kept out of read results entirely, not merely warned about. The deployment script is the one deliberate exception, and it is returned only by the tool built to show it, `get_deployment_script` — see below for what it withholds even there.

`get_site` withholds something further: Forge's own answer for one site also carries a bundle of *related* records alongside it — the server that hosts the site (including its credential key material), any tags, recent deployments, and firewall/redirect rules. None of that bundle is returned, at all — not summarised, not partially. `get_site` gives you the one site record and nothing else attached to it; use `list_servers`/`get_server` for anything about the site's server, `get_deployments` for its deployment history, and nothing here yet for tags or firewall/redirect rules.

Every successful result also opens with a standing `data_notice` field. That is not an error indicator — it appears on every normal result and exists to tell whatever is reading the output that the record values that follow (a server name, a site domain, a git branch) were written by whoever administers your Forge account, not by this server, and should not be treated as instructions.

## Why a name or domain can look slightly different than in the Forge dashboard

Every piece of text these tools copy from your account — a server name, a site domain, an alias, a git branch — passes through the same visible-text rule [[error-messages]] describes for a quoted Forge error, before it reaches the agent. In practice that can mean:

- A character that renders as nothing (an invisible formatting character some tool or paste added) is silently removed, rather than shown as a gap.
- Anything else out of the ordinary — an exotic space, an unassigned character — comes through as a single plain space.
- An emoji built from several joined characters (a family, a flag) can arrive as its separate parts, and a colour emoji can arrive as its plain black-and-white outline.
- Accented letters, and the combining marks used by scripts such as Devanagari, Thai and Arabic, are kept and continue to render correctly — a name in one of these scripts is not affected.

Nothing in Forge itself changes, and nothing is renamed — this only affects what forge-mcp is willing to repeat into an AI agent's context, for the reason [[error-messages]] gives for redaction: text written by someone else must not be able to carry hidden instructions or unreadable characters into what the agent reads. If a name looks off, the Forge dashboard always shows the real, unmodified value.

## How to tell whether a deployment script is exactly what Forge has stored

`get_deployment_script` is the one tool here whose result is allowed to keep line breaks, blank lines and the spacing inside the script — a script's structure is part of what it says, so flattening it the way every other field above is flattened would hand you back something that reads as complete and correct while actually running its lines together. Only what genuinely does not render, or does not render as itself, is touched: an invisible character is removed, and anything else that isn't a letter, digit, punctuation, symbol, mark, space, tab or line break becomes a plain space.

Two things in the result tell you if what you're reading differs from what Forge actually has stored, and neither requires comparing the text yourself:

- **`notes` says so.** If the script is longer than this server will return in one call, a note names which end was cut and warns that what runs on deploy continues past what you see. If any character in the script had to be removed or replaced for the reasons above, a separate note says exactly that — and states plainly that line breaks, blank lines, indentation and in-string spacing are untouched, so you also know what kind of change did *not* happen.
- **The `truncated` and `altered` fields** are the same two facts, machine-readable. Both are `false` on the ordinary script most sites have.

If either is `true`, or `notes` is non-empty, treat the script you were shown as informative rather than authoritative, and check the Forge dashboard directly before relying on it for anything exact — the same caution [[error-messages]] recommends for a truncated error fragment.

## See also

[[configuration]] for the environment variables that determine which organization these tools act against, and [[error-messages]] for what it means when a failed call — for example, `get_server` with an id that doesn't exist — quotes text Forge itself reported.
