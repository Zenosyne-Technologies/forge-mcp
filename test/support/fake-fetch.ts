import { readFileSync } from "node:fs";

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

/** A canned reply: a JSON body (with optional status), or an error to throw. */
export type Reply = { body?: unknown; status?: number } | Error;

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
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
    };
    calls.push(call);

    const answer =
      typeof reply === "function" ? reply(call, calls.length - 1) : reply;
    if (answer instanceof Error) throw answer;

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
