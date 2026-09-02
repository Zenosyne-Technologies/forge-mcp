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
 * `realFetch` is captured before the swap and exported for the ONE caller entitled to
 * it — `test/integration.smoke.test.ts`, which is opt-in behind an environment flag
 * and wraps it in a read-only guard of its own. Nothing lifts the guard globally:
 * there is no uninstall, because a suite that can restore real `fetch` mid-run is a
 * suite whose isolation depends on nobody calling the restore.
 */
import { expect } from "vitest";

/** The platform `fetch`, captured before the guard replaces it. */
export const realFetch: typeof fetch = globalThis.fetch;

/** Thrown when a test reaches for the network instead of injecting a fake. */
export class NetworkAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkAccessError";
  }
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
    networkRefusalMessage(init?.method ?? "GET", describeTarget(input)),
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

function describeTarget(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return String(input);
}
