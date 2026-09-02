import { ForgeError, describeHttpFailure } from "./errors.js";

export const FORGE_API_BASE = "https://forge.laravel.com/api";

export interface ForgeClientOptions {
  token: string;
  baseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
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

  constructor(options: ForgeClientOptions) {
    if (!options.token) {
      throw new ForgeError(
        "FORGE_API_KEY is not set. Create a token at https://forge.laravel.com/profile/api and expose it to this server.",
      );
    }
    this.#token = options.token;
    this.#baseUrl = options.baseUrl ?? FORGE_API_BASE;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
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
