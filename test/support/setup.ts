/**
 * What every test file gets, whether or not it asks for it.
 *
 * Registered as `setupFiles` in `vitest.config.ts`, so it runs once per test file
 * BEFORE that file is imported — a suite cannot opt out by forgetting to import it,
 * which is the whole point of putting the standing guarantees of this harness here
 * rather than in a helper each test has to remember to call:
 *
 * 1. **No network.** `globalThis.fetch` is replaced with a refusal at module scope
 *    here, again before every test, and asserted to still be the refusal after every
 *    test — so a test that reaches the real Forge API fails by name instead of passing
 *    against a live account.
 * 2. **No writes.** Every call that was actually answered is inspected after each
 *    test, and a non-GET among them fails the test that made it. `fakeFetch` already
 *    refuses one at the seam; this is the independent second lock, so removing either
 *    one on its own does not open the door.
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
 * `ForgeClient.prototype.request` puts every request issued through the client under
 * the check, whatever fetch is behind it, which is what "independent second lock"
 * has to mean to be worth having.
 *
 * Both checks run in `afterEach` rather than once at the end, because a failure that
 * names the test responsible is a failure someone can fix in a minute, and one that
 * says "somewhere in 200 tests" is a bisect.
 */
import { afterEach, beforeEach, expect } from "vitest";

import { ForgeClient } from "../../src/client.js";
import {
  recordAttempt,
  recordServed,
  resetCallLedger,
  servedCalls,
} from "./fake-fetch.js";
import { installNetworkGuard, networkGuardInstalled } from "./network-guard.js";

// Armed at import time — before the test file, its module scope and its `beforeAll`.
installNetworkGuard();
installClientWriteLedger();

beforeEach(() => {
  installNetworkGuard();
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
});

/**
 * Report every `ForgeClient` request into the ledger the after-each check reads.
 *
 * A request that RESOLVES was answered, and that is what "served" means: the refusal
 * suites deliberately attempt a write and require it to be refused, so an attempt that
 * threw must not fail the test that proved it throws.
 *
 * Wrapping the prototype changes no behaviour: it forwards arguments and result
 * untouched, and lives in the harness rather than in `src/`, so production code
 * carries nothing that exists only for tests.
 */
function installClientWriteLedger(): void {
  type Request = typeof ForgeClient.prototype.request;
  const original = ForgeClient.prototype.request as Request;

  const wrapped = async function (
    this: ForgeClient,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const call = { url: path, method };
    recordAttempt(call);
    const result = await original.call(this, method, path, body);
    recordServed(call);
    return result;
  };

  ForgeClient.prototype.request = wrapped as Request;
}
