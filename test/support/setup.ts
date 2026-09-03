/**
 * What every test file gets, whether or not it asks for it.
 *
 * Registered as `setupFiles` in `vitest.config.ts`, so it runs once per test file
 * BEFORE that file is imported — a suite cannot opt out by forgetting to import it,
 * which is the whole point of putting the standing guarantees of this harness here
 * rather than in a helper each test has to remember to call:
 *
 * 1. **No network through `fetch`.** `globalThis.fetch` is replaced with a refusal at
 *    module scope here, again before every test, and asserted to still be the refusal
 *    after every test — so a test that reaches the real Forge API through `fetch` fails
 *    by name instead of passing against a live account. It is a `fetch`-level guard:
 *    `node:http` is a different door and this does not lock it.
 * 2. **No writes through the two seams.** Every call that was actually answered by
 *    `fakeFetch` or issued through `ForgeClient` is inspected after each test, and a
 *    non-GET among them fails the test that made it. `fakeFetch` already refuses one at
 *    the seam; the client wrapper is the independent second lock, so removing either
 *    one on its own does not open the door.
 *
 * Neither is a sandbox, and neither tries to be. See test/README.md, "What these guards
 * are for": they catch the honest mistake — the client built with no `fetchImpl`, the
 * write left in a fixture-driven test — and a contributor determined to get around them
 * can. That trade is deliberate.
 *
 * WHY THE GUARD IS ARMED AT MODULE SCOPE. Arming it in `beforeEach` alone left two
 * windows open. A test file's own module scope and its `beforeAll` hooks run before
 * any `beforeEach`, so both ran against the real `fetch` — and worse, a `ForgeClient`
 * constructed in either one captures `globalThis.fetch` at construction
 * (`options.fetchImpl ?? globalThis.fetch`) and keeps it, so it went on issuing real
 * requests from inside ordinary tests, long after the guard was in place. Installing
 * here, at import time, closes both: nothing in a test file has run yet.
 *
 * WHY THE WRITE LOCK WRAPS THE CLIENT. Reading `fakeFetch`'s ledger catches writes
 * that went through `fakeFetch`, and nothing else. A suite can hand `ForgeClient` a
 * fetch it wrote by hand — `test/org.test.ts` does, to inspect the abort signal — and
 * such a stub would answer a POST with the after-each check none the wiser. Wrapping
 * `ForgeClient.prototype.request` (in `test/support/client-ledger.ts`) puts every
 * request issued through the client under the check, whatever fetch is behind it.
 *
 * BOTH SEAMS ARE RE-ASSERTED, for the same reason and with the same words. A test that
 * replaces `globalThis.fetch`, or that spies on `ForgeClient.prototype.request`, leaves
 * the rest of its file running without that guard; the failure belongs to the test that
 * did it, not to whoever writes the next one.
 *
 * Both checks run in `afterEach` rather than once at the end, because a failure that
 * names the test responsible is a failure someone can fix in a minute, and one that
 * says "somewhere in 200 tests" is a bisect.
 */
import { afterEach, beforeEach, expect } from "vitest";

import {
  clientWriteLedgerInstalled,
  installClientWriteLedger,
} from "./client-ledger.js";
import { resetCallLedger, servedCalls } from "./fake-fetch.js";
import { installNetworkGuard, networkGuardInstalled } from "./network-guard.js";

// Armed at import time — before the test file, its module scope and its `beforeAll`.
installNetworkGuard();
installClientWriteLedger();

beforeEach(() => {
  installNetworkGuard();
  installClientWriteLedger();
  resetCallLedger();
});

afterEach(() => {
  const test = expect.getState().currentTestName ?? "<unknown test>";

  const writes = servedCalls().filter((call) => call.method !== "GET");
  expect(
    writes,
    `"${test}" was served ${writes.length} non-GET request(s): ` +
      `${writes.map((c) => `${c.method} ${c.url}`).join(", ")}. ` +
      `Tests are read-only — see test/README.md.`,
  ).toEqual([]);

  expect(
    networkGuardInstalled(),
    `"${test}" left globalThis.fetch replaced, so the next test in this file would ` +
      `run unguarded and could reach the real Forge API. Restore it, or inject a ` +
      `fake through ForgeClient's fetchImpl option instead of patching the global.`,
  ).toBe(true);

  expect(
    clientWriteLedgerInstalled(),
    `"${test}" left ForgeClient.prototype.request replaced — a vi.spyOn on it does ` +
      `exactly this — so the write ledger no longer sees requests issued through the ` +
      `client, and the after-each write check above would pass on a file that writes. ` +
      `Restore the method, or inject a fake through ForgeClient's fetchImpl option.`,
  ).toBe(true);
});
