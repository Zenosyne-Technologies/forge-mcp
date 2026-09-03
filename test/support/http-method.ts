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
 * What a method that cannot be read at all is called.
 *
 * `String(value)` throws for a symbol, and for an object whose `toString` throws. The
 * platform would reject such a call too — but a guard that swallowed the throw and
 * returned GET would be answering the safest possible question wrongly, so an
 * unreadable method resolves to a name that is not GET and every guard refuses it.
 */
export const UNREADABLE_METHOD = "<unreadable method>";

/**
 * The method `fetch(input, init)` would actually send.
 *
 * Mirrors the platform's own precedence: an explicit `init.method` wins, otherwise a
 * `Request` carries its own, otherwise GET. Case is normalised upward, because
 * `fetch(url, { method: "post" })` sends a POST and a guard that compares the raw
 * string would wave it through.
 *
 * `init.method` is COERCED rather than type-tested. The platform applies ToString to
 * it, so `{ method: new String("POST") }` and `{ method: { toString: () => "DELETE" } }`
 * both send a write; a `typeof explicit === "string"` test sees neither, falls through
 * to GET, and the fake then serves the write and records it as a read. Nobody writes
 * `new String("POST")` on purpose, but a method that arrived from a helper, a config
 * object or a JSON round-trip can be a boxed string without its author noticing.
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER. `init.method` is read ONCE here and again by
 * the platform, so a getter that returns "GET" to this function and "POST" to `fetch`
 * defeats the check. Closing that would mean reading the property once and forwarding a
 * normalised `init` everywhere — and it would still only raise the price of a
 * deliberate bypass, which is not what these guards are for (see test/README.md, "What
 * these guards are for"). They catch mistakes; a test author who wants around them can
 * get around them, and this harness does not try to stop that.
 */
export function resolveRequestMethod(input: unknown, init?: RequestInit): string {
  const explicit: unknown = init?.method;
  if (explicit !== undefined && explicit !== null) {
    let coerced: string;
    try {
      coerced = String(explicit);
    } catch {
      return UNREADABLE_METHOD;
    }
    if (coerced !== "") return coerced.toUpperCase();
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
