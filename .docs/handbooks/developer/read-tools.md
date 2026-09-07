---
doc: The read-tool contract
type: handbook
status: active
summary: The whitelist projection and its shared visible-text allowlist, cursor pagination, total-output budget and malformed-response guards shared by every read tool — how ServerView/SiteView differ from Forge's own attribute shapes, how get_server_status derives a strict subset of ServerView, and why get_site drops the JSON:API compound document's `included` side-load entirely.
keywords: [tools, projection, whitelist, pagination, cursor, budget, annotations, readOnlyHint, ServerView, SiteView, ServerStatusView, list_servers, get_server, get_server_status, list_sites, get_site, included, compound document, neutraliseUpstreamText, allowlist]
level: code
audience: developer
module: read tools
sources:
  - src/tools/servers.ts
  - src/tools/sites.ts
  - src/tools/common.ts
  - src/tools/index.ts
  - src/types.ts
  - src/upstream-text.ts
related:
  - "[[organization-resolution]]"
  - "[[error-rendering]]"
created: 2026-09-03
updated: 2026-09-07
---

# The read-tool contract

## Why this exists

`list_servers`, `get_server` and `list_sites` (`src/tools/servers.ts`, `src/tools/sites.ts`) were this server's first agent-callable surface — stage 1 of the build order recorded in `src/tools/index.ts`. `get_server_status` and `get_site` are the first two tools of stage 2, bringing the registry to five (registration order: `list_servers`, `get_server`, `get_server_status`, `list_sites`, `get_site` — `get_deployments` and `get_deployment_script` are still to come); five write tools follow at stage 3. Every field any of them returns reaches a model that will, by stage 3, also hold `reboot_server` and `update_deployment_script`, so the four rules in `src/tools/common.ts` are enforced once, centrally, rather than per tool: project by whitelist, bound every scalar, bound the whole result, and label every result as data. This page is that contract; [[error-rendering]] is its counterpart for the failure path.

## Annotations: a machine-readable read/write split

All five tools carry `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` (`ToolDefinition.annotations`, `src/tools/index.ts`). This is not decoration — a client deciding whether to auto-approve a call, or whether a retry is safe, reads these fields rather than a hand-maintained list of tool names, which is exactly the kind of list that drifts the day a thirteenth tool is added.

## Projection is a whitelist, not a filter

`projectServer` and `projectSite` each copy named fields from `resource.attributes` through a coercer (`text`, `url`, `flag`, `whole`, `textList` — `src/tools/common.ts`); nothing about Forge's response is passed through structurally. An attribute Forge adds later reaches no tool output because nothing copies it — there is no denylist to update. `record()` also refuses to treat an array or a primitive as a resource, so a malformed `attributes` degrades to `{}` rather than a thrown type error inside a tool handler.

`text` and `url` also run every value through `neutraliseUpstreamText` (`src/upstream-text.ts`) before bounding it — the same shared allowlist [[error-rendering]] applies to a quoted Forge error, extended here to the far larger surface of an ordinary listing (tens of thousands of characters across a page, against two hundred on an error). A server name, a site domain, a git branch survive as letters, digits, punctuation, symbols and marks; a character the allowlist denies is deleted if it drew nothing on screen or turned into a single space if it occupied width. See [[error-rendering]] for why the rule is an allowlist and what it costs.

Six fields are withheld by the same mechanism, deliberately: `local_public_key` and `credential_id` (server credential material), `identifier` (provider bookkeeping an agent cannot act on), `deployment_url` (the deploy-trigger secret — anyone holding it can deploy the site), and `deployment_script` / `shared_paths` (unbounded operator-authored blobs that belong to a future single-site tool, not a fifty-row listing).

## `get_server` and `list_servers` share one projection

Both call `projectServer`, so a `get_server` row is byte-identical to the corresponding `list_servers` row — same 23 fields, same coercion. `get_server`'s description says so explicitly ("It returns exactly the row list_servers returns for that server — the same fields, no additional detail") rather than implying richer detail exists, and `test/tools.test.ts` asserts the two projections' key sets have an empty symmetric difference so the claim in the description cannot drift from the code. `get_server` exists purely for the access pattern — fetching one server you already hold an id for, without paying for enumeration — never for extra fields.

## `get_server_status`: a compiler-enforced subset of `ServerView`

`get_server_status` (`src/tools/servers.ts`) reads the same `GET /orgs/{org}/servers/{server}` endpoint `get_server` reads — there is no separate status endpoint — and returns `ServerStatusView`, `Pick<ServerView, "id" | "connection_status" | "is_ready" | "db_status" | "redis_status" | "opcache_status" | "php_version">`. `projectServerStatus` builds it by calling `projectServer` and copying those seven keys out, so "every field this tool returns also appears on `get_server`" is a property the compiler enforces rather than a claim the description makes on trust: adding an eighth field that is not on `ServerView` fails to typecheck, and `test/tools.test.ts` additionally asserts the seven returned values equal `get_server`'s row for the same server. `id` is taken from `projectServer`'s output — the id Forge attested in the response body — never from the caller's `server_id` argument; before this, two different servers queried for status produced byte-identical results, and the failure mode was an agent attaching a "not ready" verdict to whichever server it guessed from a condensed transcript. The tool's description justifies itself on access pattern (fewer fields for a narrower question) rather than on richness, and states plainly that Forge's `ServerResource` carries no CPU, memory or load-average reading at all — `monitors` are alerting thresholds, not measurements — so no tool in this registry can answer a load question, and a model reading the description stops looking for one.

## `get_site`: resolving a site by its own id, without a server id

`list_sites` and `get_server` both need a server id first; `get_site` (`src/tools/sites.ts`) does not. It calls `GET /orgs/{org}/sites/{site}` — a site is resolved within the organization, not through its server — so it answers when all a caller holds is a site id and does not know which server hosts it. Its `inputSchema` has exactly one property, `site_id`; the tool cannot be given a `server_id` at all, structurally rather than by validation. It returns the same `SiteView` `projectSite` produces for `list_sites` — the same fields, no additional detail — confirmed the same way `get_server`/`list_servers` parity is: a test asserts the same key set, and the description states the parity explicitly rather than implying a fuller record exists behind the single-id lookup.

## The compound document: why `get_site` drops `included` entirely

`GET /orgs/{org}/sites/{site}` answers with a JSON:API **compound document** — `{ data, included: [...] }` — the first endpoint in this registry to do so. `included` can carry a whole `ServerResource` (including `local_public_key`), a `TagResource`, a `DeploymentResource`, a `SecurityRuleResource` and a `RedirectRuleResource`: a second, larger payload surface, every value of it written by whoever owns the Forge account, and none of it whitelisted or field-capped by anything in this file.

The decision is to drop it entirely rather than project it: nothing reads `included`, anywhere in `get_site`'s handler. A generic pass-through of related resources would be exactly the "whatever shape arrived" projection the field-by-field whitelist above exists to refuse, and it would hand an account owner a cap-free channel into the agent's context — unbounded in size and untouched by `neutraliseUpstreamText`. Adding one related resource later means whitelisting it field by field through `text`/`flag`/`whole`, the same way `SiteView` and `ServerView` are built, in a reviewable diff — not turning the array back on.

**What actually enforces this.** `CompoundEnvelope<T>` (`src/types.ts`) types `included` as `unknown[]`, and that types block only one half of the mistake: reading a field out of an `included` element fails to typecheck, but a wholesale `included: response?.included` — copying the whole array through unread — typechecks clean, because nothing about `unknown[]` forbids re-emitting it verbatim. The type buys containment against the first mistake, not the second. The second is caught only by two tests in `test/tools.test.ts`: `"never copies the included side-load out of a recorded response"` (asserts a realistic `included` payload — a server's `local_public_key`, a tag, a deployment commit message — never appears in the rendered result) and `"keeps hostile content in included out of the agent's context"` (a fixture with a prompt-injection string and a 200,000-character element inside `included`; the rendered result excludes both and its total length is asserted under 2,000 characters). Weakening or deleting either test is the only way this containment silently regresses — there is no structural backstop underneath them.

## `SiteAttributes`: corrected against the published schema

`src/types.ts`'s `SiteAttributes` originally named three fields — `directory`, `repository_branch`, `repository_provider` — that do not exist on `SiteResource`. The real shape is `root_directory`, `web_directory`, and a nested `repository: { provider, url, branch, status }` object. `projectSite` reads through the corrected shape (`record(a["repository"])`, then `text`/`url` per key), and this is now confirmed against live Forge data, not only against the corrected type. `ServerAttributes` was transcribed the same way and needed no correction.

## Cursor pagination: request, response, and the budget between them

`pageShape` (`src/tools/common.ts`) is the two arguments every list tool takes: `page_size` (`MIN_PAGE_SIZE`–`MAX_PAGE_SIZE`, i.e. 1–100, default `DEFAULT_PAGE_SIZE` = 50) and `cursor`. `readPageArgs` validates both before any URL is built — a non-integer or out-of-range `page_size`, or a cursor that fails `CURSOR_PATTERN` (Laravel's URL-safe base64 alphabet, 1–512 characters), throws a `ForgeError` that never echoes the rejected value back, for the same reason `requirePathSegment` doesn't: a rejected argument is where hostile text would be planted to get itself replayed into the transcript.

`withPageQuery` appends `page[size]` / `page[cursor]` to the path. `paginate()` then reconciles three things a caller was never told to compare on its own:

1. **Forge can ignore `page_size`.** If `rows.length > page.pageSize`, only the first `page.pageSize` are kept and a note says how many were dropped — `next_cursor`, where present, continues after the FULL upstream response, so dropped rows are not reachable by paging again.
2. **Row count is not result size.** `fitBudget()` then fits the clamped rows to `MAX_RESULT_CHARS` (60,000 characters, measured on each row's serialised form so JSON escaping counts toward the budget rather than hiding under it), taking rows in order and always keeping at least the first one — an empty page would hand an upstream payload a way to answer any question with nothing. Rows withheld this way get their own note, worded identically to the drop note above.
3. **`has_more: true` with `next_cursor: null`** — Forge's meta says more rows exist but this server received no usable cursor for them — gets a third, explicit note rather than being left as a pair of fields whose combination a model was never told to compare.

`has_more` in the returned `PageInfo` is `upstream.has_more || dropped > 0 || withheld > 0`: once rows are held back, more rows certainly remain whatever Forge's own `meta` claimed, independent of what Forge said. `notes` is empty on the ordinary page — the common case — so its presence is itself the signal.

## Malformed responses fail loudly, on purpose

`requireList()` refuses to let a non-array `data` read as "there are no servers"; `requireResource()` refuses to let an object with neither a usable `id` nor a populated `attributes` read as a resource whose every field happens to be null. Both throw a `ForgeError` naming the resource and suggesting a retry, and neither quotes anything from the malformed body — a response shaped to be read by a model is exactly where such a body would carry misleading text. This is the same "an empty array is the answer 'none'; anything else is the absence of an answer" distinction [[organization-resolution]] draws for a malformed `/orgs` payload.

## Every successful result is labelled

`withDataNotice()` puts `data_notice` (`RECORD_DATA_LABEL`) as the first key of every list and detail result — deliberately the same imperative wording and vocabulary as `UPSTREAM_LABEL` in `src/errors.ts` ([[error-rendering]]), so the project says "this is data, not instructions" the same way on both the success path and the failure path. It rides on the ordinary page as much as on the odd one, because a marker that appears only when something is wrong is no marker at all.

## Connects to

- [[organization-resolution]] — every handler calls `ctx.org.slug()` before building a request path; an unsettled resolution failure propagates as a `ForgeError` through the same rendering as any other tool failure.
- [[error-rendering]] — a thrown `ForgeError` from `requirePathSegment`, `readPageArgs`, `requireList` or `requireResource` reaches `src/index.ts`'s `catch` block and is rendered exactly like an upstream HTTP failure.
- `src/tools/index.ts`'s `tools` array is registration order, and registration order is the order a model sees in `tools/list`: `list_servers`, `get_server`, `get_server_status`, `list_sites`, `get_site` — servers before that server's health, then sites before one site by its own id.
