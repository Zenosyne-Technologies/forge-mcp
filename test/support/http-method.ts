/**
 * How a `fetch` call decides what method it is sending — decided once, here.
 *
 * Every guard in this harness turns on one question: is this a GET? Reading
 * `init?.method ?? "GET"` answers it for the call shape the suites happen to use and
 * gets it WRONG for the other one the platform accepts:
 *
 *     fetch(new Request(url, { method: "POST" }))   // init is undefined
 *
 * A guard that reads only `init` sees `undefined`, calls that GET, and passes the
 * request through to whatever it was wrapping — the fake serves it, or the real socket
 * carries it to a live Forge account. The method was never hidden; it was on the
 * `Request` the whole time.
 *
 * So the resolution lives in ONE function that `fake-fetch.ts`, `read-only.ts` and
 * `network-guard.ts` all call. Three copies of this rule are three chances for two of
 * them to be fixed and the third to stay wrong, and the third is the one that reaches
 * production infrastructure.
 */

/** The one method the default suite and the read-only transport will let through. */
export const GET = "GET";

/**
 * The method `fetch(input, init)` would actually send.
 *
 * Mirrors the platform's own precedence: an explicit `init.method` wins, otherwise a
 * `Request` carries its own, otherwise GET. Case is normalised upward, because
 * `fetch(url, { method: "post" })` sends a POST and a guard that compares the raw
 * string would wave it through.
 */
export function resolveRequestMethod(input: unknown, init?: RequestInit): string {
  const explicit = init?.method;
  if (typeof explicit === "string" && explicit !== "") {
    return explicit.toUpperCase();
  }
  if (input instanceof Request) return input.method.toUpperCase();
  return GET;
}

/** Whether that method is the single one every guard here permits. */
export function isReadMethod(input: unknown, init?: RequestInit): boolean {
  return resolveRequestMethod(input, init) === GET;
}

/** The target of a call, however it was addressed, for a message a human reads. */
export function describeRequestTarget(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return String(input);
}
