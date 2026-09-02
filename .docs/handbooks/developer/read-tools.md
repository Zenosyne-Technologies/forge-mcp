---
doc: The read-tool contract
type: handbook
status: active
summary: The whitelist projection and its shared visible-text allowlist, cursor pagination, total-output budget and malformed-response guards shared by every read tool — and how ServerView/SiteView differ from Forge's own attribute shapes.
keywords: [tools, projection, whitelist, pagination, cursor, budget, annotations, readOnlyHint, ServerView, SiteView, list_servers, get_server, list_sites, neutraliseUpstreamText, allowlist]
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
updated: 2026-09-03
---

# The read-tool contract

## Why this exists

`list_servers`, `get_server` and `list_sites` (`src/tools/servers.ts`, `src/tools/sites.ts`) are this server's first agent-callable surface — stage 1 of the build order recorded in `src/tools/index.ts`, with the remaining read tools at stage 2 and five write tools at stage 3. Every field they return reaches a model that will, by stage 3, also hold `reboot_server` and `update_deployment_script`, so the four rules in `src/tools/common.ts` are enforced once, centrally, rather than per tool: project by whitelist, bound every scalar, bound the whole result, and label every result as data. This page is that contract; [[error-rendering]] is its counterpart for the failure path.

## Annotations: a machine-readable read/write split

All three tools carry `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` (`ToolDefinition.annotations`, `src/tools/index.ts`). This is not decoration — a client deciding whether to auto-approve a call, or whether a retry is safe, reads these fields rather than a hand-maintained list of tool names, which is exactly the kind of list that drifts the day a thirteenth tool is added.

## Projection is a whitelist, not a filter

`projectServer` and `projectSite` each copy named fields from `resource.attributes` through a coercer (`text`, `url`, `flag`, `whole`, `textList` — `src/tools/common.ts`); nothing about Forge's response is passed through structurally. An attribute Forge adds later reaches no tool output because nothing copies it — there is no denylist to update. `record()` also refuses to treat an array or a primitive as a resource, so a malformed `attributes` degrades to `{}` rather than a thrown type error inside a tool handler.

`text` and `url` also run every value through `neutraliseUpstreamText` (`src/upstream-text.ts`) before bounding it — the same shared allowlist [[error-rendering]] applies to a quoted Forge error, extended here to the far larger surface of an ordinary listing (tens of thousands of characters across a page, against two hundred on an error). A server name, a site domain, a git branch survive as letters, digits, punctuation, symbols and marks; a character the allowlist denies is deleted if it drew nothing on screen or turned into a single space if it occupied width. See [[error-rendering]] for why the rule is an allowlist and what it costs.

Six fields are withheld by the same mechanism, deliberately: `local_public_key` and `credential_id` (server credential material), `identifier` (provider bookkeeping an agent cannot act on), `deployment_url` (the deploy-trigger secret — anyone holding it can deploy the site), and `deployment_script` / `shared_paths` (unbounded operator-authored blobs that belong to a future single-site tool, not a fifty-row listing).

## `get_server` and `list_servers` share one projection

Both call `projectServer`, so a `get_server` row is byte-identical to the corresponding `list_servers` row — same 23 fields, same coercion. `get_server`'s description says so explicitly ("It returns exactly the row list_servers returns for that server — the same fields, no additional detail") rather than implying richer detail exists, and `test/tools.test.ts` asserts the two projections' key sets have an empty symmetric difference so the claim in the description cannot drift from the code. `get_server` exists purely for the access pattern — fetching one server you already hold an id for, without paying for enumeration — never for extra fields.

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
- `src/tools/index.ts`'s `tools` array is registration order, and registration order is the order a model sees in `tools/list`: servers, then one server, then that server's sites — the order a caller actually walks.
