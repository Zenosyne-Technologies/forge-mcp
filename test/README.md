# `test/` — the harness

Everything here runs with **no network** and **no credential**.

## What these guards are for

**They catch an honest mistake. They are not a sandbox, and they do not try to be.**

The adversary this harness is built against is a contributor who leaves a real network
call in by accident, or writes a test that would mutate production without meaning to —
the `ForgeClient` built with no `fetchImpl`, the method that turned out not to be a
`GET`, the fixture recorded with a live token still in it. Against that, the guards
below are strong, and they fail by naming the test that tripped them.

A test author who *wants* around them can get around them. Any test can
`require("node:http")` and open a socket; a stack check can be spoofed; a wrapper can be
replaced by something that forwards. None of that is defended here, deliberately: an
in-process check cannot win that race, and pretending otherwise is worse than admitting
it, because a guarantee people believe is absolute is one they stop reading the diff
for. **What follows says what each guard actually sees.** Where it is blind, it says so.

## The two standing guarantees

Armed by `test/support/setup.ts` (registered as `setupFiles` in `vitest.config.ts`, so
no suite can forget to opt in), for every test file:

1. **`globalThis.fetch` cannot reach the network.** It is replaced with a refusal at
   that file's **module scope** — which Vitest runs before your test file is imported,
   so module scope and `beforeAll` are covered too — again before each test, and
   asserted to still be the refusal after it. The real `fetch` is not exported; it is
   handed out by `claimRealFetch()`.
   *What it does not see:* anything that is not `fetch`. `node:http`, `node:https`,
   `node:net` and a child process all reach a real socket with this guard in place. No
   test does that today, and nothing here would notice if one did.
2. **Two seams refuse a non-GET.** `fakeFetch` answers `GET` and refuses every other
   method, and an after-each check re-reads what was actually *served*. That check
   covers any injected fetch used through the client: `setup.ts` wraps
   `ForgeClient.prototype.request`, so a hand-rolled `fetchImpl` that answers a write
   fails the test that made it.
   *What it does not see:* a write issued by a fetch that is neither `fakeFetch` nor
   reached through `ForgeClient` — a stub a test calls directly, holding its own
   reference. Nothing records that, so nothing checks it.

Both seams are re-asserted after every test — `networkGuardInstalled()` and
`clientWriteLedgerInstalled()` — because a test that replaces either leaves the rest of
its file running without it. An ordinary `vi.spyOn(ForgeClient.prototype, "request")`
is enough to remove the second one, with no intent to evade at all; that is the case
the re-assertion is for.

Every guard resolves the method the same way `fetch` does — `test/support/http-method.ts`,
one function, called by the fake seam, the network guard and the read-only transport
alike — because `new Request(url, { method: "POST" })` carries its method on the request
and not in `init`, and because the platform applies `ToString` to `init.method`, so
`{ method: new String("POST") }` sends a POST. A guard that read
`init.method` only when it was already a string called that a GET, served it, and
recorded it as a read.
*What it does not see:* `init.method` is read once here and again by the platform, so a
getter returning a different value on the second read defeats it. That is a deliberate
bypass, not a mistake, and is out of scope per the section above.

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
| `test/fixtures/**.json` | Recorded Forge API payloads. Data only — no logic, no secrets. |
| `test/support/fake-fetch.ts` | The injection seam: `fakeFetch()`, `fixture()`, the write refusal, and the call ledger. |
| `test/support/http-method.ts` | How a request's method and target are resolved. One rule, used by every guard. |
| `test/support/network-guard.ts` | The offline guarantee, and `claimRealFetch()` — the recorded way to the real `fetch`. |
| `test/support/client-ledger.ts` | The `ForgeClient.prototype.request` wrapper: the second write lock, and the check that it is still installed. |
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
- **No credential, ever.** Enforced, not requested — see below. `deployment_url` is the
  sharp one: a real Forge deploy trigger is an **unauthenticated write URL**, and anyone
  holding it can deploy the site with no token and no account. The recorded ones carry
  the placeholder `deploytoken`.
- **Keep the shared invariants.** `test/harness.test.ts` asserts every fixture parses,
  carries `data`, and (for `*-page-*`) carries `meta.next_cursor`. A recording that
  drifts from the shape the code parses fails there rather than in a suite that looks
  like it is testing something else.

## The mechanical checks

Conventions nobody enforces rot, so each of these is a test. Each row says what the
check sees; none of them sees more than that.

| check | where | what it does |
|---|---|---|
| Offline | `harness.test.ts` → "the default suite cannot reach the network" | Calls the real API through `globalThis.fetch` and requires the refusal, including through a `ForgeClient` built with no `fetchImpl` — the mistake that actually happens — and from module scope and `beforeAll`. `fetch` only: `node:http` is a different door. |
| No writes | `harness.test.ts` → "no test performs a write of any kind" | Attempts POST/PUT/PATCH/DELETE at the seam, on a `Request` object, with a non-string method, and through `ForgeClient`, and requires each to be refused and never served. A write answered by a hand-rolled `fetchImpl` *used through the client* is caught by the ledger; one issued by a stub a test calls directly is not seen at all. |
| Ledger still installed | `harness.test.ts` → "the client write ledger is checked as the fetch guard is" | The wrapper on `ForgeClient.prototype.request` is compared against the one that was installed, after every test. Catches a `vi.spyOn` or an assignment; a replacement that deliberately forwarded to the original would pass. |
| Real `fetch` | `harness.test.ts` → "only the integration smoke test can obtain the real fetch" | `claimRealFetch()` reads its own **stack text** and refuses a caller whose stack does not name `integration.smoke.test`, and refuses every caller unless `FORGE_MCP_INTEGRATION=1`, recording each claim it grants. That catches an ordinary import from another suite, and keeps `npm test` from holding a network handle at all. It is text, not an identity: a caller determined to forge a stack can, and this does not stop it. |
| No credentials | `harness.test.ts` → "no fixture carries a credential" | See below for exactly what is scanned. |
| Error branches | `error-mapping.test.ts` | One owning test per status branch of `describeHttpFailure`, plus a check that reads the branches back out of `src/errors.ts`. See below for the shapes it understands. |
| Read-only integration | `integration.smoke.test.ts` → "the read-only guarantees" | Runs flag or no flag: asserts every tool it calls is `readOnlyHint: true`, scans its own source for mutating tool names, and proves its transport refuses non-GET. |

### What the credential scan reads

- **Every file under `test/`, at any depth**, whatever its extension — fixtures,
  sources, this README, `tsconfig.json`. Both halves of that were once narrower: a token
  in `test/fixtures/sub/x.json` or in `test/notes.txt` went unread. The one exclusion is
  a list of extensions that are bytes rather than text (`.png`, `.jpg`, `.jpeg`, `.gif`,
  `.webp`, `.ico`, `.pdf`, `.zip`, `.gz`, `.woff`, `.woff2`), declared in the file and
  matched by nothing committed today.
- **Named credential shapes** — PEM private key blocks, GitHub, OpenAI, Stripe, AWS,
  Slack tokens, JWTs — which a scanner can recognise without knowing the value.
- **Long opaque strings** (40+ alphanumerics), the shape a Forge API token has, unless
  the exact string is in `ALLOWED_LOOKALIKES` with a reason; today, one SSH **public**
  key.
- **Secrets carried in a query string**: a parameter named `token`, `api_key`,
  `access_token`, `auth`, `key`, `secret`, `signature` and the like must carry a value
  listed in `ALLOWED_QUERY_SECRETS`. This is the rule that covers a real
  `deployment_url`, whose token is far shorter than forty characters and which the
  opaque-run scan therefore never saw.
- **The value of `FORGE_API_KEY`**, if the machine running the suite has one — the only
  check here that can see a real token.

It is a scan for shapes, not a proof of absence: a credential that looks like ordinary
prose passes it. It is the mistake that gets caught, again.

Two checks bound what an allowlist row can be:

- **A row must be one whole opaque string** (40+ alphanumerics, nothing else) **with a
  stated reason** — or, for a query placeholder, one short lowercase word. Stripping is
  substring replacement, so a short value does not exempt one string, it dissolves every
  string: a row of `{ value: "0" }` deletes every zero from the scanned text, breaks a
  real token into fragments too short to match, and leaves the scan reporting nothing
  for evermore.
- **A row that no longer matches anything fails**, so an exemption cannot outlive the
  recording that needed it.

Every suite that needs a token uses the sentinel `"test-token"`, and that is asserted
too. A real credential in that position is then obvious on sight.

### What the error-branch scan understands

It reads `src/errors.ts` and extracts the statuses `describeHttpFailure` dispatches on.
Adding a branch without a row in `BRANCHES` fails **for the shapes it can read**:

- `case <number>:`, and `case <IDENT>:` for a module-level numeric constant
- `status === <number>` and `<number> === status`, and the `!==` forms, anywhere in the
  body — including a guard placed before the `switch`
- `[409, 410].includes(status)`
- `TABLE[status]` and `LIST.includes(status)`, for a module-level object or array
  literal it can read numbers out of
- `isConflict(status)`, followed one level into a top-level `function` declaration and
  scanned there against that function's own parameter name

Anything else — an arrow-function predicate, a helper imported from another module, a
table built at run time, a case label it cannot value — is reported as **unresolved**,
which fails the "understood every branch it read" test with the offending text. So a
shape it has never seen makes it complain rather than silently bless. It is a regex over
source, not a compiler; the list above is its whole vocabulary.

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

`claimRealFetch()` answers a caller whose stack text contains `integration.smoke.test`
and only when `FORGE_MCP_INTEGRATION=1` is set; every other claim is refused by name
and every claim it grants is recorded. That is a filename substring, not this file's
identity — a sibling Vitest collects whose path carries it is equally entitled — and
it says nothing about what the caller then does: wrapping the result in
`readOnlyTransport` is this file's own doing, not something the guard enforces.

It calls `list_servers`, `get_server` and `list_sites` and nothing else. Three
independent things stop it mutating:

1. Every tool it names is asserted `readOnlyHint: true` and `destructiveHint: false`
   against the live registry.
2. Its own source is scanned for the name of every mutating tool — the five the
   roadmap plans, listed in `test/support/read-only.ts`, and anything in the registry
   not annotated read-only.
3. `readOnlyTransport` wraps the real `fetch` and throws on any method but GET —
   whether the method arrives in `init`, on a `Request`, or as something the platform
   would coerce to a string.

All three run on every `npm test`, flag or no flag: they are guarantees about what the
file *could* do, so they would be worthless if they only held on the runs where it
does it. What they cover is **what goes through that transport**. A request this file
made with the real `fetch` it holds, without wrapping it, would not pass through the
check — nothing revokes the reference once it has been handed over.

## For stage 3, when the write tools arrive

The guards above are deliberately in the way, and each has one intended answer:

- **`fakeFetch` refuses non-GET, with no opt-in parameter.** A write tool's tests must
  come to `test/support/fake-fetch.ts` and change it in a reviewable diff. Whatever
  replaces the current refusal must keep `servedCalls()` honest.
- **Amending `fakeFetch` is not enough on its own.** The after-each check in
  `test/support/setup.ts` hard-asserts that **zero** non-GET requests were served — by
  the fake or by any fetch used through `ForgeClient` — so a write test still fails
  after the seam has been opened, until that second file is amended too. Two files,
  two decisions, deliberately: that is what "second, independent lock" means, and it
  is the reason removing either one alone does not open the door.
- **A write test must not simply clear the ledger.** `resetCallLedger()` is called in
  exactly one test today — "catches a write served by a hand-rolled fetchImpl the fake's
  ledger never sees", which deliberately gets a POST answered to prove the lock sees it,
  and must then clear the evidence or fail its own after-each check. Anywhere else it is
  a guard being switched off rather than answered. **Nothing enforces that**: it is a
  convention this paragraph states and review upholds, and a second call to it would go
  unnoticed by the suite.
- **`error-mapping.test.ts` will need rows** for any status a write path introduces
  (`409`, `423`). The source-parsing check fails until they exist *if the branch is
  written in a shape the scan reads* — the list is above — and reports the branch as
  unresolved if it is not. Either way it goes red; it does not go quiet.
- **`integration.smoke.test.ts` must not grow a write call.** It fails the moment its
  source names one. The roadmap's rule is absolute: *no test ever deploys, reboots or
  rewrites a script.* A suite that can mutate production is a suite nobody dares run.

## What this file is not

This is the mechanical reference for people editing tests, kept next to the tests so
it is found by the person about to break it. The product-level account — how the
harness fits the architecture, why the fetch seam was chosen over module mocking, and
what a contributor should verify before a release — belongs in
`.docs/handbooks/developer/`, which the documentation stage owns.
