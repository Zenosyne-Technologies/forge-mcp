/**
 * The default suite cannot reach the network — proven, not promised.
 *
 * "These tests inject a fake fetch" is a claim about every test that exists today. It
 * says nothing about the one written next week by someone who constructs
 * `new ForgeClient({ token })` without a `fetchImpl` and does not notice, because
 * `ForgeClient` falls back to `globalThis.fetch` and a real request against a real
 * Forge account is exactly what a green test looks like until it is run on a machine
 * with no credential, or no route out, or a colleague's token in the environment.
 *
 * So the claim is replaced with a mechanism: `globalThis.fetch` is swapped for a
 * function that cannot make a request and can only throw, and the throw names the
 * test that leaked, the method and the target. A test that reaches the network fails
 * loudly at the moment it reaches, rather than passing quietly against production.
 *
 * The swap is armed at MODULE scope in `test/support/setup.ts`, which Vitest runs
 * before the test file is imported — so a `beforeAll`, or a `ForgeClient` built at
 * module scope (which captures `globalThis.fetch` at construction and keeps it), is
 * covered too. Arming it in `beforeEach` alone left both of those running against the
 * real `fetch`, and a client that captured it there leaked from inside ordinary tests
 * for the rest of the file.
 *
 * The real `fetch` is captured before the swap and is NOT exported. It is handed out
 * by `claimRealFetch()`, which serves one caller — `test/integration.smoke.test.ts`,
 * which wraps it in a read-only transport of its own — and only on a run that asked
 * for it with `FORGE_MCP_INTEGRATION=1`. Everyone else is refused by name, and every
 * claim that succeeds is recorded so that use of it is visible rather than assumed.
 * Nothing lifts the guard globally: there is no uninstall, because a suite that can
 * restore real `fetch` mid-run is a suite whose isolation depends on nobody calling
 * the restore.
 */
import { expect } from "vitest";

import { describeRequestTarget, resolveRequestMethod } from "./http-method.js";
import { INTEGRATION_FLAG, integrationEnabled } from "./read-only.js";

/**
 * The platform `fetch`, captured before the guard replaces it.
 *
 * Module-private on purpose. Exported, it was a handle on the real network that every
 * file in the suite could import with nothing to stop it and nothing to notice it.
 */
const realFetch: typeof fetch = globalThis.fetch;

/**
 * The one file entitled to the real `fetch`.
 *
 * Matched against the call stack rather than passed in as a password: a caller cannot
 * claim to be the smoke test without actually being called from it, and nobody can
 * grant themselves the entitlement by copying a constant.
 */
export const ENTITLED_REAL_FETCH_CALLER = "integration.smoke.test";

const claims: string[] = [];

/** Every claim on the real `fetch` since the process started, newest last. */
export function realFetchClaims(): readonly string[] {
  return claims;
}

/** Thrown when a test reaches for the network instead of injecting a fake. */
export class NetworkAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkAccessError";
  }
}

/**
 * Hand the real `fetch` to the one suite allowed to hold it, on the runs that asked
 * for the network.
 *
 * Two conditions, both required. The caller's stack must name the entitled file, and
 * the integration flag must be set — so an ordinary `npm test` cannot obtain a live
 * network handle at all, no matter which file asks. Every other caller gets a
 * `NetworkAccessError` naming what it should have used, so "only the integration
 * smoke test may reach the network, and only when asked" is enforced at the moment of
 * the reach rather than written in a comment above an export everyone can import.
 */
export function claimRealFetch(): typeof fetch {
  const stack = new Error("claim").stack ?? "";
  const caller = stack.split("\n").slice(2).join("\n");

  if (!caller.includes(ENTITLED_REAL_FETCH_CALLER)) {
    throw new NetworkAccessError(
      [
        `Refused a claim on the real fetch from outside`,
        `test/${ENTITLED_REAL_FETCH_CALLER}.ts.`,
        `It is the only suite entitled to it: it is opt-in behind`,
        `${INTEGRATION_FLAG}=1 and wraps what it gets in readOnlyTransport().`,
        `Build a stub with fakeFetch() from test/support/fake-fetch.ts instead.`,
      ].join(" "),
    );
  }

  // The entitlement is about WHICH file may hold the real `fetch`; the flag is about
  // WHETHER anything may hold it on this run. Without this second check the entitled
  // file was handed a live network handle on every `npm test`, flag or no flag, and
  // the only thing standing between that handle and an unauthenticated request to
  // somebody's production Forge was that the tests using it happened to send methods
  // the read-only transport refuses. A contributor adding the obvious "and a GET
  // passes through" case would have removed that accident.
  if (!integrationEnabled()) {
    throw new NetworkAccessError(
      [
        `Refused a claim on the real fetch: ${INTEGRATION_FLAG} is not set.`,
        `The real fetch is handed out only on an opt-in integration run`,
        `(${INTEGRATION_FLAG}=1 npm run test:integration), so an ordinary`,
        `npm test never holds a handle on the network at all.`,
        `Build a stub with fakeFetch() from test/support/fake-fetch.ts instead.`,
      ].join(" "),
    );
  }

  claims.push(expect.getState().currentTestName ?? "<outside any test>");
  return realFetch;
}

/**
 * What a leaking test is told.
 *
 * Named separately so the suite that proves the guard asserts on the same text the
 * guard emits, rather than on a paraphrase of it.
 */
export function networkRefusalMessage(method: string, target: string): string {
  const test = expect.getState().currentTestName ?? "<outside any test>";
  return [
    `Blocked real network access from the test suite.`,
    `"${test}" attempted ${method} ${target}.`,
    `The default suite runs with no network: build a stub with fakeFetch() from`,
    `test/support/fake-fetch.ts and pass it as ForgeClient's fetchImpl option.`,
    `See test/README.md for the fixture layout and the injection pattern.`,
  ].join(" ");
}

const guardedFetch = (async (input: unknown, init?: RequestInit) => {
  throw new NetworkAccessError(
    // The same shared resolution the fake seam and the read-only transport use, so a
    // POST carried on a `Request` is reported as a POST here too.
    networkRefusalMessage(
      resolveRequestMethod(input, init),
      describeRequestTarget(input),
    ),
  );
}) as unknown as typeof fetch;

/** Swap `globalThis.fetch` for the refusal. Idempotent. */
export function installNetworkGuard(): void {
  globalThis.fetch = guardedFetch;
}

/**
 * Whether the guard is still the global `fetch`.
 *
 * Checked after every test as well as before it: a test that assigns
 * `globalThis.fetch` — deliberately, or through a library that patches it — would
 * otherwise leave the next test in the same file unguarded, and the leak would land
 * on whoever wrote that next test rather than on whoever removed the guard.
 */
export function networkGuardInstalled(): boolean {
  return globalThis.fetch === guardedFetch;
}
