# `test/` — the harness

Everything here runs with **no network** and **no credential**. Two guarantees hold for
every test file, armed by `test/support/setup.ts` (registered as `setupFiles` in
`vitest.config.ts`, so no suite can forget to opt in):

1. **Nothing reaches the network.** `globalThis.fetch` is replaced with a refusal at
   that file's **module scope** — which Vitest runs before your test file is imported,
   so module scope and `beforeAll` are covered too — again before each test, and
   checked to still be the refusal after it. The real `fetch` is not exported: it is
   handed out by `claimRealFetch()`, which refuses every caller but the integration
   smoke test.
2. **Nothing writes.** The fake transport answers `GET` and refuses every other method,
   and an independent after-each check re-reads what was actually served. That check
   covers **any** injected fetch, not only `fakeFetch`: `setup.ts` wraps
   `ForgeClient.prototype.request`, so a hand-rolled `fetchImpl` that answers a write
   fails the test that made it.

Both guards resolve the method the way `fetch` does — `test/support/http-method.ts`,
one function, three callers — because `new Request(url, { method: "POST" })` carries
its method on the request and not in `init`, and a guard reading `init` alone waves it
through.

```
npm test                 # the whole suite, offline
npm run test:watch       # the same, watching
npm run test:integration # opt-in, real Forge, read-only (see below)
npm run typecheck        # src/ AND test/ — the harness is typechecked too
```

## Layout

| path | what it is |
|---|---|
| `test/*.test.ts` | The suites. One file per subject, named after it. |
| `test/fixtures/*.json` | Recorded Forge API payloads. Data only — no logic, no secrets. |
| `test/support/fake-fetch.ts` | The injection seam: `fakeFetch()`, `fixture()`, the write refusal, and the call ledger. |
| `test/support/http-method.ts` | How a request's method and target are resolved. One rule, used by all three guards. |
| `test/support/network-guard.ts` | The offline guarantee, and `claimRealFetch()` — the entitled, recorded way to the real `fetch`. |
| `test/support/read-only.ts` | What the integration smoke test may call, and the transport that enforces it. |
| `test/support/setup.ts` | Arms both guarantees for every file. Not imported by tests; wired in `vitest.config.ts`. |
| `test/tsconfig.json` | Typechecks `test/` (the root config compiles `src/` only). Run by `npm run typecheck`. |

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
| Offline | `harness.test.ts` → "the default suite cannot reach the network" | Calls the real API and requires the refusal, including through a `ForgeClient` built with no `fetchImpl` — the mistake that actually happens — and from module scope and `beforeAll`, which the guard used to miss. |
| No writes | `harness.test.ts` → "no test performs a write of any kind" | Attempts POST/PUT/PATCH/DELETE at the seam, on a `Request` object, and through `ForgeClient`, and requires each to be refused and never served. A write answered by a hand-rolled `fetchImpl` is caught by the ledger. |
| Real `fetch` | `harness.test.ts` → "only the integration smoke test can obtain the real fetch" | `claimRealFetch()` throws for any caller but `integration.smoke.test.ts`, and records every claim. |
| No credentials | `harness.test.ts` → "no fixture carries a credential" | Scans every fixture and every `.ts`/`.md` file under `test/` — both for credential shapes and for long opaque strings — and for the value of `FORGE_API_KEY` if this machine has one. |
| Error branches | `error-mapping.test.ts` | One owning test per status branch of `describeHttpFailure`, plus a check that reads the branches back out of `src/errors.ts`: numeric `case` labels, labels written as named constants, and `status === <n>` guards anywhere in the function. Adding a branch without a row fails, and a branch the scan cannot resolve fails rather than being skipped. |
| Read-only integration | `integration.smoke.test.ts` → "the read-only guarantees" | Runs flag or no flag: asserts every tool it calls is `readOnlyHint: true`, scans its own source for mutating tool names, and proves its transport refuses non-GET. |

### The credential scan and its allowlist

The scan is shape-based, because the value it must catch is one nobody has seen yet. A
long opaque string — in a fixture or in a test source — fails unless it is listed in
`ALLOWED_LOOKALIKES` with a reason; today, one SSH **public** key.

Adding a row is a reviewable decision, and two checks bound what a row can be:

- **A row must be one whole opaque string** (40+ alphanumerics, nothing else) **with a
  stated reason.** Stripping is substring replacement, so a short value does not exempt
  one string, it dissolves every string: a row of `{ value: "0" }` deletes every zero
  from the scanned text, breaks a real token into fragments too short to match, and
  leaves the scan reporting nothing for evermore.
- **A row that no longer matches any fixture fails**, so an exemption cannot outlive
  the recording that needed it.

That is the whole of it. The allowlist still widens the scan by exactly what a row
says — the checks make a row say what it is, and make its removal noticed.

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

It is also the only file `claimRealFetch()` will answer: every other caller gets a
`NetworkAccessError` naming it, and every claim is recorded. It calls `list_servers`,
`get_server` and `list_sites` and nothing else. Three independent things stop it
mutating:

1. Every tool it names is asserted `readOnlyHint: true` and `destructiveHint: false`
   against the live registry.
2. Its own source is scanned for the name of every mutating tool — the five the
   roadmap plans, listed in `test/support/read-only.ts`, and anything in the registry
   not annotated read-only.
3. `readOnlyTransport` wraps the real `fetch` and throws on any method but GET —
   whether the method arrives in `init` or on a `Request` — so a mutating request
   cannot leave the process.

All three run on every `npm test`, flag or no flag: they are guarantees about what the
file *could* do, so they would be worthless if they only held on the runs where it
does it.

## For stage 3, when the write tools arrive

The guards above are deliberately in the way, and each has one intended answer:

- **`fakeFetch` refuses non-GET, with no opt-in parameter.** A write tool's tests must
  come to `test/support/fake-fetch.ts` and change it in a reviewable diff. Whatever
  replaces the current refusal must keep `servedCalls()` honest.
- **Amending `fakeFetch` is not enough on its own.** The after-each check in
  `test/support/setup.ts` hard-asserts that **zero** non-GET requests were served — by
  the fake or by any fetch injected into `ForgeClient` — so a write test still fails
  after the seam has been opened, until that second file is amended too. Two files,
  two decisions, deliberately: that is what "second, independent lock" means, and it
  is the reason removing either one alone does not open the door.
- **A write test must not simply clear the ledger.** `resetCallLedger()` is called in
  exactly one test today, which demonstrates the lock catching a hand-rolled write and
  says so; anywhere else it is a guard being switched off rather than answered.
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
