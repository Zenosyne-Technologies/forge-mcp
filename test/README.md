# `test/` — the harness

Everything here runs with **no network** and **no credential**. Two guarantees hold for
every test file, armed by `test/support/setup.ts` (registered as `setupFiles` in
`vitest.config.ts`, so no suite can forget to opt in):

1. **Nothing reaches the network.** `globalThis.fetch` is replaced with a refusal
   before each test and checked to still be the refusal after it.
2. **Nothing writes.** The fake transport answers `GET` and refuses every other
   method, and an independent after-each check re-reads what was actually served.

```
npm test                 # the whole suite, offline
npm run test:watch       # the same, watching
npm run test:integration # opt-in, real Forge, read-only (see below)
```

## Layout

| path | what it is |
|---|---|
| `test/*.test.ts` | The suites. One file per subject, named after it. |
| `test/fixtures/*.json` | Recorded Forge API payloads. Data only — no logic, no secrets. |
| `test/support/fake-fetch.ts` | The injection seam: `fakeFetch()`, `fixture()`, and the write refusal. |
| `test/support/network-guard.ts` | The offline guarantee, and the one exported handle on the real `fetch`. |
| `test/support/read-only.ts` | What the integration smoke test may call, and the transport that enforces it. |
| `test/support/setup.ts` | Arms both guarantees for every file. Not imported by tests; wired in `vitest.config.ts`. |

## The injection pattern

`ForgeClient` takes a `fetchImpl` option. That is the whole seam — there is no module
mocking anywhere in this suite, and none should be added: a recorded call list and a
canned reply cover every case so far, and they stay readable when a test fails.

```ts
import { ForgeClient } from "../src/client.js";
import { fakeFetch, fixture } from "./support/fake-fetch.js";

const TOKEN = "test-token"; // The shared sentinel. Never a real credential.

const forge = fakeFetch({ body: fixture("servers-page-1") });
const client = new ForgeClient({ token: TOKEN, fetchImpl: forge.fetchImpl });

// …exercise the code under test…

expect(forge.calls).toEqual([
  { url: "https://forge.laravel.com/api/orgs/zenosyne-ltd/servers", method: "GET" },
]);
```

`forge.calls` records every request the client attempted, in order — assert on it
rather than on a spy. `ForgeClient` also takes `baseUrl` and `timeoutMs`; `timeoutMs`
exists so a timeout test does not have to wait thirty real seconds.

### The replies a fake can serve

`fakeFetch` takes one reply, or a function `(call, index) => reply` when a suite needs
the first attempt to differ from the second:

| reply | what it simulates |
|---|---|
| `{ body, status? }` | A JSON response. `status` defaults to 200. |
| `{ text, status? }` | A `text/html` body — a proxy or WAF answering instead of Forge, and the only way to exercise the non-JSON path in `readJson`. |
| `{ hang: true }` | A request accepted and never answered. Only the client's own `AbortSignal` ends it, which is how the timeout is proven. |
| `new Error(…)` | A transport failure — DNS, TLS, connection refused. `unreachableFetch()` is the ready-made one. |

### If a test needs the network

It does not. If `globalThis.fetch` refuses a call, the fix is to pass a `fetchImpl`,
not to lift the guard. The refusal message names the test, the method and the target.

## The fixture layout

Fixtures are payloads recorded from the live API with read-only calls, then trimmed of
anything identifying. `fixture("servers-page-1")` loads `test/fixtures/servers-page-1.json`
— the name is the file name without the extension.

Naming, so a fixture is findable without opening it:

- `<resource>-page-<n>.json` — one page of a list response. Carries `data` and the
  `meta` block with `next_cursor`, because the pager reads it.
- `<resource>-single.json` — one detail response, `data` as an object.
- `<resource>-<condition>.json` — a deliberate edge: `orgs-empty`, `orgs-multiple`,
  `orgs-single-null-entry`, `orgs-multiple-injected-slug`.

Rules:

- **A fixture is data.** No helpers, no computed values. A payload a test builds by
  hand belongs inline in that test, where the reader can see what it is exercising.
- **Record what Forge sends, including the fields the tools drop.** `deployment_url`
  and `deployment_script` are in `sites-page-1.json`, and `local_public_key` is in the
  server fixtures, precisely so the suites can prove they never reach a tool result. A
  fixture trimmed to only the fields the code reads cannot prove that.
- **No credential, ever.** Enforced, not requested — see below.
- **Keep the shared invariants.** `test/harness.test.ts` asserts every fixture parses,
  carries `data`, and (for `*-page-*`) carries `meta.next_cursor`. A recording that
  drifts from the shape the code parses fails there rather than in a suite that looks
  like it is testing something else.

## The mechanical checks

Conventions nobody enforces rot, so each of these is a test.

| check | where | what it does |
|---|---|---|
| Offline | `harness.test.ts` → "the default suite cannot reach the network" | Calls the real API and requires the refusal, including through a `ForgeClient` built with no `fetchImpl` — the mistake that actually happens. |
| No writes | `harness.test.ts` → "no test performs a write of any kind" | Attempts POST/PUT/PATCH/DELETE at the seam and through `ForgeClient`, and requires each to be refused and never served. |
| No credentials | `harness.test.ts` → "no fixture carries a credential" | Scans every fixture and every file under `test/` for credential shapes and for long opaque strings, and for the value of `FORGE_API_KEY` if this machine has one. |
| Error branches | `error-mapping.test.ts` | One owning test per status branch of `describeHttpFailure`, plus a check that reads the `switch` back out of `src/errors.ts`. Adding a `case` without a row fails. |
| Read-only integration | `integration.smoke.test.ts` → "the read-only guarantees" | Runs flag or no flag: asserts every tool it calls is `readOnlyHint: true`, scans its own source for mutating tool names, and proves its transport refuses non-GET. |

### The credential scan and its allowlist

The scan is shape-based, because the value it must catch is one nobody has seen yet.
A long opaque string in a fixture fails unless it is listed in `ALLOWED_LOOKALIKES`
with a reason — today, one SSH **public** key. Adding a row is a reviewable decision;
a row that stops matching anything also fails, so the allowlist cannot quietly widen.

Every suite that needs a token uses the sentinel `"test-token"`, and that is asserted
too. A real credential in that position is then obvious on sight.

## The opt-in integration smoke test

`test/integration.smoke.test.ts` is the only suite that talks to a real account.

```
FORGE_MCP_INTEGRATION=1 FORGE_API_KEY=… npm run test:integration
```

Without `FORGE_MCP_INTEGRATION=1` its live calls are **skipped, not omitted** — they
appear in the `skipped` count on every `npm test`, so nobody has to remember the file
exists. `FORGE_ORG` is optional; without it the resolver discovers the organization,
which is itself worth exercising. The token is read from the environment and from
nowhere else, and nothing in the file prints it.

It calls `list_servers`, `get_server` and `list_sites` and nothing else. Three
independent things stop it mutating:

1. Every tool it names is asserted `readOnlyHint: true` and `destructiveHint: false`
   against the live registry.
2. Its own source is scanned for the name of every mutating tool — the five the
   roadmap plans, listed in `test/support/read-only.ts`, and anything in the registry
   not annotated read-only.
3. `readOnlyTransport` wraps the real `fetch` and throws on any method but GET, so a
   mutating request cannot leave the process.

All three run on every `npm test`, flag or no flag: they are guarantees about what the
file *could* do, so they would be worthless if they only held on the runs where it
does it.

## For stage 3, when the write tools arrive

The guards above are deliberately in the way, and each has one intended answer:

- **`fakeFetch` refuses non-GET, with no opt-in parameter.** A write tool's tests must
  come to `test/support/fake-fetch.ts` and change it in a reviewable diff. Whatever
  replaces the current refusal must keep `servedCalls()` honest — the after-each check
  in `test/support/setup.ts` reads it and is the second, independent lock.
- **`error-mapping.test.ts` will need rows** for any status a write path introduces
  (`409`, `423`); the source-parsing check fails until they exist.
- **`integration.smoke.test.ts` must not grow a write call.** It fails the moment its
  source names one. The roadmap's rule is absolute: *no test ever deploys, reboots or
  rewrites a script.* A suite that can mutate production is a suite nobody dares run.

## What this file is not

This is the mechanical reference for people editing tests, kept next to the tests so
it is found by the person about to break it. The product-level account — how the
harness fits the architecture, why the fetch seam was chosen over module mocking, and
what a contributor should verify before a release — belongs in
`.docs/handbooks/developer/`, which the documentation stage owns.
