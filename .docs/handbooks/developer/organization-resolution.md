---
doc: Organization resolution & request timeout
type: handbook
status: active
summary: How OrganizationResolver supplies the organization segment every Forge API path needs — lazily, cached as a verdict rather than a message, with FORGE_ORG as a discovery-skipping override — and the request timeout that protects it.
keywords: [organization, resolver, forge, lazy, cache, verdict, timeout, forge-org]
level: code
audience: developer
module: organization resolution
sources:
  - src/org.ts
  - src/client.ts
related:
  - "[[configuration]]"
  - "[[error-rendering]]"
created: 2026-09-02
updated: 2026-09-03
---

# Organization resolution & request timeout

## Why this exists

Forge's current API scopes almost every path under `/orgs/{organization}/...`. `OrganizationResolver` (`src/org.ts`) is what supplies that segment, so a tool handler asks it for a slug instead of assuming one exists.

## Resolution is lazy, on purpose

`OrganizationResolver.slug()` is never called during MCP `initialize` — only on the first tool invocation. The constructor touches neither the network nor throws. This is a deliberate trade-off: resolving eagerly would let a Forge outage block the MCP handshake itself, so the server would fail to connect at all instead of failing one call with an explanation of why.

## `FORGE_ORG` skips discovery entirely

When set, `FORGE_ORG` is trimmed and, if non-blank, used as-is — no `GET /orgs` request is ever made. A blank or whitespace-only value is treated the same as unset and falls through to discovery (a stray newline from a shell profile should not silently become part of a URL path). The value is checked against `isUsableInPath` — the slug pattern Forge itself issues, no slashes, no `..` — before use, because it is interpolated directly into the request path. A value that fails this check throws without ever echoing the value back: an operator who pastes the wrong environment variable must not see it reflected into a transcript.

## Discovery: at most one settled verdict per process

Without `FORGE_ORG`, the resolver issues `GET /orgs` once and shares the in-flight promise across concurrent first calls — one round trip regardless of how many tool calls arrive before it resolves. What happens next depends on what Forge said:

- **Exactly one visible organization** resolves silently to its slug.
- **Zero, or more than one with no `FORGE_ORG` set,** throws, naming the available slugs.
- **A malformed `/orgs` payload, or a single organization with no usable slug,** throws, telling the operator to set `FORGE_ORG`.
- **401 / 403** throws as a credential verdict, distinct from a discovery verdict.

Each of these is a **settled verdict**: cached for the life of the process and never re-asked. A rejected token or an ambiguous account cannot become unambiguous mid-process, so there is no reason to hit Forge again for the same question.

The deliberate exception is a failure that says nothing final — a transport failure, a timeout, a `429`, a `5xx`. Those are not cached: the in-flight promise is dropped on failure, and the next tool call tries again from scratch.

## What is cached is a verdict, never a message

The cache holds a closed union — `{ kind: "credentials" | "malformed" | "none" | "unidentifiable-single" | "ambiguous", ... }` — never the rendered error text and never the upstream response body. `settledError()` rebuilds the message an agent reads from that verdict on every call, and every branch of that message is authored in this repository, not derived from Forge's response.

This matters because a resolver failure surfaces as tool output straight into an agent's context. If the cache held rendered text instead of a verdict, a single crafted (or merely verbose) 403 response could be replayed verbatim into that context on every later tool call, for the rest of the process, from one upstream request.

The one exception to "the cache holds no upstream strings" is the `ambiguous` verdict, which needs organization names to be useful to an operator. Those names are filtered through `isUsableInPath` — the same predicate `FORGE_ORG` itself must pass — before being stored, and capped at `MAX_LISTED_ORGANIZATIONS` (10) entries with an "and N more" tail. The cached verdict is therefore a fixed, bounded shape no matter how many organizations, or how much text per organization, Forge's response actually contained.

## Request timeout

`ForgeClient.request()` (`src/client.ts`) aborts any request that runs past `REQUEST_TIMEOUT_MS` (30 seconds), via `AbortSignal.timeout()`. `fetch` has no timeout of its own, and because concurrent first calls share one in-flight discovery promise, a single hung connection would otherwise wedge every later tool call behind a promise that can never settle — recoverable only by restarting the process.

An abort surfaces as a `ForgeError` on the same path as a transport failure, and like one it settles no verdict: the in-flight promise is dropped and the next tool call asks again, exactly as it would after a `429` or a `5xx`.

### A timeout is not a failed call

What the abort establishes is that no answer arrived in time — not that the request never landed. It may have been received and executed in full, with only the reply lost on the way back. For `GET /orgs`, and for a read generally, that distinction is academic: the call is idempotent, so re-asking costs at worst a round trip, which is why the resolver may retry it freely. For a write — a deployment triggered, a server rebooted, a deployment script rewritten — the distinction is the whole question, because sending the request again can perform the action a second time.

So a timed-out write is an **unknown** outcome, not a failed one. Neither `ForgeClient` nor the agent above it may retry one on the assumption that nothing happened; the remedy is to read the resource back, establish what the state actually is, and let the caller decide deliberately whether to send it again.

## Connects to

- `src/index.ts` constructs one `OrganizationResolver` per process and hands it to every tool handler through `ToolContext`.
- `src/tools/index.ts` declares `org: OrganizationResolver` on `ToolContext`; a tool handler calls `ctx.org.slug()` to get the path segment it needs.
- An unsettled discovery failure (a transport error, a timeout, a `429`, a `5xx`) is not a verdict this resolver builds itself — it propagates the `ForgeError` `ForgeClient.request()` raised, rendered per [[error-rendering]].

See [[configuration]] for what an operator does with `FORGE_ORG` and what each error message means.
