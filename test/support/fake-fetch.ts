import { readFileSync } from "node:fs";

import { describeRequestTarget, resolveRequestMethod } from "./http-method.js";

/**
 * Test seam for the Forge API: `ForgeClient` takes an injectable `fetchImpl`, so a
 * test never touches the network and never needs a real token.
 *
 * Deliberately not a mocking framework — a recorded call list and a canned reply are
 * everything the suites need, and later issues reuse this same pair.
 */

/** Reads a JSON fixture from `test/fixtures/<name>.json`. */
export function fixture<T = unknown>(name: string): T {
  const path = new URL(`../fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export interface RecordedCall {
  url: string;
  method: string;
}

export interface FakeFetch {
  /** Pass to `new ForgeClient({ token, fetchImpl })`. */
  fetchImpl: typeof fetch;
  /** Every request the client attempted, in order. */
  calls: RecordedCall[];
}

/**
 * Thrown when a fake is asked for anything but a GET.
 *
 * Stage 1 exposes three read tools and the roadmap's rule for the whole project is
 * that **no test ever deploys, reboots or rewrites a script**. A convention nobody
 * enforces is a convention that rots, so the seam every test already goes through
 * refuses the method outright rather than trusting each test to choose GET.
 *
 * There is deliberately NO opt-in parameter. When stage 3 adds the five mutating
 * tools, their tests cannot reach a write by passing an option — someone has to come
 * to this file and decide, in a reviewable diff, what a fake is now allowed to serve.
 * Whatever they build must keep `servedCalls()` honest: the aggregate check in
 * `test/support/setup.ts` reads it after every test and is the second, independent
 * lock on the same door.
 */
export class WriteAttemptError extends Error {
  constructor(method: string, url: string) {
    super(
      `Blocked a ${method} to ${url}. Tests are read-only: no test may deploy, ` +
        `reboot, rewrite a deployment script, or issue any non-GET request. ` +
        `See test/README.md.`,
    );
    this.name = "WriteAttemptError";
  }
}

/** The one method a fake will answer. */
export const ALLOWED_METHOD = "GET";

const attempted: RecordedCall[] = [];
const served: RecordedCall[] = [];

/** Every call any fake was asked for since the last reset, refused ones included. */
export function attemptedCalls(): readonly RecordedCall[] {
  return attempted;
}

/**
 * Every call a fake actually answered since the last reset.
 *
 * The write check asserts on THIS list rather than on `attemptedCalls()`: a refused
 * write attempted nothing, and the suite that proves the refusal has to be able to
 * attempt one. What must never appear here is a non-GET that got an answer.
 */
export function servedCalls(): readonly RecordedCall[] {
  return served;
}

/**
 * Record an attempt made by something that is not a `fakeFetch`.
 *
 * The ledger is the harness's account of what the suite asked for and what it got, and
 * it is only as complete as the paths that write to it. `fakeFetch` is not the only
 * way a request is issued: a suite can hand `ForgeClient` a fetch it wrote by hand
 * (`test/org.test.ts` does, legitimately, to inspect the abort signal), and such a
 * stub answers whatever it likes without this file ever seeing it.
 *
 * So `test/support/setup.ts` wraps `ForgeClient.prototype.request` and reports through
 * here, which puts every request issued through the client — whatever fetch is behind
 * it — under the same after-each check.
 */
export function recordAttempt(call: RecordedCall): void {
  attempted.push(call);
}

/** Record that such a request was ANSWERED. See `servedCalls()` for why it matters. */
export function recordServed(call: RecordedCall): void {
  served.push(call);
}

/** Called between tests by `test/support/setup.ts`. */
export function resetCallLedger(): void {
  attempted.length = 0;
  served.length = 0;
}

/**
 * A canned reply: a JSON body (with optional status), a raw `text` body served as
 * `text/html` — what a proxy or WAF returns when it answers instead of Forge, and the
 * only way to exercise the non-JSON path in `readJson` — an error to throw, or
 * `{ hang: true }`: a request that is accepted and then never answered, which only
 * the caller's own `AbortSignal` can end. That is what a real hung upstream does,
 * and it is the only way to prove the client's timeout is what frees the caller.
 */
export type Reply =
  | { body?: unknown; status?: number }
  | { text: string; status?: number }
  | { hang: true }
  | Error;

/**
 * Builds a fetch that records calls and answers with `reply` — or, when `reply` is a
 * function, with whatever it returns for that attempt (index is 0-based, so a suite
 * can fail the first call and serve the second).
 */
export function fakeFetch(
  reply: Reply | ((call: RecordedCall, index: number) => Reply),
): FakeFetch {
  const calls: RecordedCall[] = [];

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    // Resolved by the shared rule, not by reading `init`: a `Request` carries its own
    // method, and a fake that reported `fetch(new Request(url, { method: "POST" }))`
    // as a GET would both serve the write and record it as a read.
    const call: RecordedCall = {
      url: describeRequestTarget(input),
      method: resolveRequestMethod(input, init),
    };
    calls.push(call);
    attempted.push(call);
    if (call.method !== ALLOWED_METHOD) {
      throw new WriteAttemptError(call.method, call.url);
    }
    served.push(call);

    const answer =
      typeof reply === "function" ? reply(call, calls.length - 1) : reply;
    if (answer instanceof Error) throw answer;

    if ("hang" in answer) {
      // Exactly like a stalled real request: nothing here ever resolves it, so the
      // abort signal the client attached is the only thing that can.
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (!signal) return;
        if (signal.aborted) return reject(signal.reason as Error);
        signal.addEventListener("abort", () => reject(signal.reason as Error), {
          once: true,
        });
      });
    }

    if ("text" in answer) {
      return new Response(answer.text, {
        status: answer.status ?? 200,
        headers: { "Content-Type": "text/html" },
      });
    }

    return new Response(JSON.stringify(answer.body ?? null), {
      status: answer.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

/** A Forge that is simply down: every attempt rejects, as a DNS/TLS failure would. */
export function unreachableFetch(): FakeFetch {
  return fakeFetch(new Error("connect ECONNREFUSED forge.laravel.com:443"));
}
