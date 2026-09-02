/**
 * What every test file gets, whether or not it asks for it.
 *
 * Registered as `setupFiles` in `vitest.config.ts`, so it runs once per test file
 * before that file's tests — a suite cannot opt out by forgetting to import it, which
 * is the whole point of putting the two standing guarantees of this harness here
 * rather than in a helper each test has to remember to call:
 *
 * 1. **No network.** `globalThis.fetch` is replaced with a refusal before every test
 *    and asserted to still be the refusal after every test, so a test that reaches
 *    the real Forge API fails by name instead of passing against a live account.
 * 2. **No writes.** Every call a fake actually answered is inspected after each test,
 *    and a non-GET among them fails the test that made it. `fakeFetch` already
 *    refuses one at the seam; this is the independent second lock, so removing either
 *    one on its own does not open the door.
 *
 * Both checks run in `afterEach` rather than once at the end, because a failure that
 * names the test responsible is a failure someone can fix in a minute, and one that
 * says "somewhere in 200 tests" is a bisect.
 */
import { afterEach, beforeEach, expect } from "vitest";

import { resetCallLedger, servedCalls } from "./fake-fetch.js";
import { installNetworkGuard, networkGuardInstalled } from "./network-guard.js";

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
