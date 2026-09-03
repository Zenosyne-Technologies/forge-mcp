---
doc: Test harness strategy
type: handbook
status: active
summary: Why the harness enforces its guarantees at the fetchImpl seam instead of module mocking, how it fits the tool/client architecture, its stated threat model, and what a contributor adding a write tool must do to satisfy it.
keywords: [testing, harness, fetchImpl, seam, network-guard, write-lock, threat-model, vitest, integration test, stage 3]
level: code
audience: developer
module: test harness
sources:
  - test/support/setup.ts
  - test/support/network-guard.ts
  - test/support/client-ledger.ts
  - test/support/fake-fetch.ts
  - test/support/http-method.ts
  - test/support/read-only.ts
  - test/harness.test.ts
  - test/error-mapping.test.ts
  - test/integration.smoke.test.ts
  - test/tsconfig.json
  - vitest.config.ts
related:
  - "[[organization-resolution]]"
  - "[[error-rendering]]"
created: 2026-09-03
updated: 2026-09-03
---

# Test harness strategy

`test/README.md` is the mechanical reference for this harness — every guard, every
check, exact behaviour, exact blind spot. This page does not restate it. What belongs
here is the decision underneath it: why the harness is shaped the way it is, how that
shape follows from `ForgeClient`'s own architecture, and what it obliges a contributor
to do next.

## Why `fetchImpl`, not module mocking

`ForgeClient` (`src/client.ts`) already took an injectable `fetchImpl` before this
harness existed — it exists so the client stays "testable without a resolver," per its
own doc comment. The harness's central decision was to make that constructor option
the *only* seam, rather than adding `vi.mock("node-fetch")` or an HTTP-interception
library on top of it.

The reason is what each approach can prove. A module mock replaces an import; it says
nothing about what the code under test actually sent, only what the test told the mock
to return. A recorded call list — `forge.calls` in `test/support/fake-fetch.ts` — is
the request the client actually built: URL, method, and (via the seam every guard
shares, `test/support/http-method.ts`) the *resolved* method, not the string a test
believes it passed. Asserting against that list is asserting against behaviour, not
against a wired-up double. It also means there is exactly one thing to make offline and
write-safe — the value passed as `fetchImpl` — instead of a mocking layer that would
need its own guarantee that it, too, cannot leak a real request. `test/README.md`'s
"the injection pattern" section is the resulting shape; this is why it is the only
shape.

## How the harness fits the architecture

The harness's two standing guarantees line up with the two places `ForgeClient` can be
reached, not with the test files:

- **The network guard** (`test/support/network-guard.ts`) sits at `globalThis.fetch`
  itself, armed at module scope by `test/support/setup.ts` before any test file's own
  code runs. It has to sit that low because `ForgeClient`'s constructor falls back to
  `globalThis.fetch` when no `fetchImpl` is given — the exact mistake the guard exists
  to catch is a test that forgot to construct the client with one.
- **The write ledger** (`test/support/client-ledger.ts`) wraps
  `ForgeClient.prototype.request` — the one method every tool handler calls, per
  [[organization-resolution]]'s note that a handler reaches Forge only through the
  client the process constructed for it. Wrapping the prototype method, rather than
  asking every test to wrap its own `fetchImpl`, means a fake seam that gets the method
  wrong is caught regardless of which test file wrote it.

Both are re-armed and re-asserted after every test (`networkGuardInstalled()`,
`clientWriteLedgerInstalled()`) rather than once per suite, because either can be
silently removed by code that has no intention of evading anything — `vi.spyOn` on
`ForgeClient.prototype.request` is the worked example `test/README.md` gives, and nulls
out the ledger with a single ordinary spy call.

The method-resolution helper (`test/support/http-method.ts`) exists as its own file,
shared by the fake seam, the network guard, and `test/support/read-only.ts`'s
integration transport, because getting it wrong once and getting it wrong three
different ways are different failure classes. `fetch`'s own coercion rules
(`new Request(url, { method }).method`, and `ToString` applied to a non-string
`init.method`) are not obvious from reading a test, so this project encodes them once
and has every guard call the same function rather than re-deriving them.

The error-branch forcing function (`error-mapping.test.ts`, reading
`describeHttpFailure` in `src/errors.ts`) is the harness's answer to a different
problem: [[error-rendering]] is a fan-out of status-specific branches, each authored
by hand, and nothing in the type system requires a new branch to ship with a test. The
scan reads the source back and fails on any status it dispatches on but cannot match to
an owning test — which makes an *added, untested* branch fail loudly, at the cost of
also failing loudly on a branch shape it cannot parse (an arrow-function predicate, a
runtime-built table). That trade is deliberate: a false "unresolved" is a build failure
a reviewer reads once, a silently-passing untested branch is a bug that survives to
production.

## The threat model, and why it stops where it stops

Stated at the top of `test/README.md`: **these guards catch an honest mistake, not a
determined test author.** A test can `require("node:http")` directly, or hold its own
reference to the real `fetch` and call it without going through the wrapped seam — the
harness does not defend against either, and says so rather than implying a coverage it
does not have.

That boundary follows from what an in-process check can actually establish. Every
guard here runs in the same process, same privilege level, as the test it is checking;
nothing sandboxes a test file away from the language's own escape hatches. A guard that
tried to imply it caught deliberate evasion would be a guarantee someone stops
re-verifying by reading the diff — which is a worse position than an honestly narrow
one. So the harness is scoped to the actual population of mistakes this project has:
someone constructs a client with no `fetchImpl`, someone's hand-rolled fake answers a
method it shouldn't, someone adds a status branch and forgets the test, someone commits
a fixture with a token still in it. Each of the checks in `test/README.md`'s
"mechanical checks" table is aimed at exactly one of those, and each states in the same
table what it does not see.

The practical consequence for review: a PR that adds test infrastructure claiming to
"prevent" a network call or a write, full stop, is claiming more than this project's
own harness claims for itself. The right question for a reviewer is the one
`test/README.md` answers per-guard — what does this specific check see, and what would
slip past it.

## For stage 3: adding a write tool

`test/README.md`'s "For stage 3, when the write tools arrive" section is the mechanical
checklist — which files change and in what order. The reason each of those changes is
required, rather than optional hardening, is architectural:

- **`fakeFetch` refuses every non-GET today because no write tool exists yet.** The
  refusal is not a permanent policy the harness enforces forever; it is what "no write
  path is implemented" looks like as a test assertion. The day `src/tools/` grows a
  write tool, that assertion becomes false by design, and `test/support/fake-fetch.ts`
  has to change in the same PR that makes it false — not as cleanup after, because
  until it changes no test can exercise the new tool's success path at all.
- **The ledger in `test/support/setup.ts` is a second, independent gate on the same
  fact**, checked in `afterEach` rather than at the seam. This is deliberate
  duplication: the invariant that matters — *zero writes reached the client this test
  used* — is asserted twice, at two different points a change could break it, so that
  loosening `fakeFetch` alone does not silently open the door. A write tool's tests pass
  only once both files agree writes are now expected and validated.
- **`error-mapping.test.ts` will need new rows the moment a write path introduces a
  status `describeHttpFailure` didn't previously branch on** (`409`, `423`, and
  similar) — because the scan reads branches out of `src/errors.ts` itself, a write
  tool that needs new error handling drags its own test requirement in behind it
  automatically, provided the new branch is written in one of the shapes the scanner
  understands.
- **`integration.smoke.test.ts` is architecturally barred from ever growing a write
  call**, independent of what the other guards allow. `test/support/read-only.ts`
  lists the mutating tool names by hand and the suite scans its own source for them;
  this is the one guard in the harness that stays absolute rather than tracking what
  the product currently does, because the smoke test's entire value is running against
  a real account, and a real account is not a place this project's tests get to
  experiment on.

## No admin-facing surface

This harness has no runtime behaviour, no environment variable, and no operational
concern — it runs at `npm test` and nowhere else, on a machine a contributor controls,
against no live infrastructure except the opt-in integration smoke test a contributor
must deliberately flag on. There is no admin handbook page for it, and none is expected
as write tools are added, unless a future change gives the suite itself something an
operator needs to configure.

## Connects to

- [[organization-resolution]] — the client method every tool handler calls, and the
  one the write ledger wraps, is the same `ForgeClient.prototype.request` this page
  describes from the test side.
- [[error-rendering]] — `error-mapping.test.ts`'s forcing function is the test-side
  half of keeping every `describeHttpFailure` branch covered; this page explains why
  that check exists and what it does when it cannot parse a branch.
- `test/README.md` — the mechanical reference: exact guard behaviour, exact blind
  spots, the fixture and mechanical-check tables, and the literal stage-3 checklist.
