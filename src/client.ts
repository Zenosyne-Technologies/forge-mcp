import { ForgeError, describeHttpFailure } from "./errors.js";

export const FORGE_API_BASE = "https://forge.laravel.com/api";

/**
 * How long one Forge request may take before it is aborted.
 *
 * `fetch` has no timeout of its own, so a connection that is accepted and then never
 * answered hangs its promise forever. That is not merely a slow call: callers share
 * one in-flight discovery promise, so a single hung request would wedge every later
 * tool call behind a promise that can never settle, and only a process restart would
 * recover it. Thirty seconds is far longer than Forge's slowest normal reply and far
 * shorter than an agent session, so a timeout means "this call did not land" — a
 * transport failure, retryable like any other.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

export interface ForgeClientOptions {
  token: string;
  baseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to `REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * Thin HTTP client for the Forge API.
 *
 * Knows nothing about organizations or tools — it authenticates, sends, and turns
 * failures into ForgeError. Organization scoping is applied by the caller so that
 * this stays testable without a resolver.
 */
export class ForgeClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ForgeClientOptions) {
    if (!options.token) {
      throw new ForgeError(
        "FORGE_API_KEY is not set. Create a token at https://forge.laravel.com/profile/api and expose it to this server.",
      );
    }
    this.#token = options.token;
    this.#baseUrl = options.baseUrl ?? FORGE_API_BASE;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    const response = await this.#fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // No request may outlive this signal: an unanswered call must fail, not hang.
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    const payload = await readJson(response);

    if (!response.ok) {
      throw new ForgeError(
        describeHttpFailure(response.status, path, payload),
        response.status,
      );
    }
    return payload as T;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // A non-JSON body is itself diagnostic: a removed API route serves HTML.
    return text.slice(0, 300);
  }
}
