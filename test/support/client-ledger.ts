/**
 * The second lock: every request issued through `ForgeClient`, reported to the ledger.
 *
 * `fakeFetch` records what IT was asked for and nothing else, so a suite that hands
 * `ForgeClient` a fetch it wrote by hand (`test/org.test.ts` does, legitimately, to
 * inspect the abort signal) could have a write ANSWERED with the after-each check none
 * the wiser. Wrapping `ForgeClient.prototype.request` puts every request through the
 * client under that check, whatever fetch is behind it.
 *
 * WHY THE INSTALL IS CHECKABLE. The fetch guard is re-asserted after every test by
 * `networkGuardInstalled()`, because a test that replaces `globalThis.fetch` would
 * otherwise leave the REST of its file unguarded. This wrapper had no equivalent, so
 * the two seams were asymmetric for no reason anyone chose: an ordinary
 * `vi.spyOn(ForgeClient.prototype, "request")` — a thing a contributor writes without
 * any intent to evade — replaces it, and every write through the client after that
 * point goes unrecorded. `clientWriteLedgerInstalled()` closes the asymmetry.
 *
 * This is a check against a MISTAKE, like every other guard here. It compares the
 * current prototype method against the function this module installed; a replacement
 * that deliberately forwarded to the original would pass it, and that is fine — see
 * test/README.md, "What these guards are for".
 */
import { ForgeClient } from "../../src/client.js";
import { recordAttempt, recordServed } from "./fake-fetch.js";

type ClientRequest = typeof ForgeClient.prototype.request;

/** The wrapper this module put on the prototype, or `null` before the first install. */
let installed: ClientRequest | null = null;

/**
 * Report every `ForgeClient` request into the ledger the after-each check reads.
 *
 * A request that RESOLVES was answered, and that is what "served" means: the refusal
 * suites deliberately attempt a write and require it to be refused, so an attempt that
 * threw must not fail the test that proved it throws.
 *
 * Wrapping the prototype changes no behaviour: it forwards arguments and result
 * untouched, and lives in the harness rather than in `src/`, so production code carries
 * nothing that exists only for tests.
 *
 * Idempotent, and re-installable. Called again while the wrapper is still in place it
 * does nothing — wrapping the wrapper would record every call twice. Called after
 * something replaced the method, it wraps whatever is there now, so a test that
 * restores its own spy in an `afterEach` is not punished for the order hooks run in.
 */
export function installClientWriteLedger(): void {
  if (installed !== null && ForgeClient.prototype.request === installed) return;

  const original = ForgeClient.prototype.request as ClientRequest;

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

  installed = wrapped as ClientRequest;
  ForgeClient.prototype.request = installed;
}

/**
 * Whether the wrapper this module installed is still the prototype method.
 *
 * The counterpart of `networkGuardInstalled()`, and asserted in the same `afterEach`
 * for the same reason: a test that replaced it leaves the rest of its file with no
 * write ledger, and the failure should land on the test that replaced it rather than
 * on whoever writes the next one.
 */
export function clientWriteLedgerInstalled(): boolean {
  return installed !== null && ForgeClient.prototype.request === installed;
}
