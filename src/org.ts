import type { ForgeClient } from "./client.js";
import { ForgeError } from "./errors.js";
import type { Envelope, Organization } from "./types.js";

/**
 * A slug is interpolated straight into `/orgs/{organization}/...`, so an override
 * that carries a slash, a scheme or a traversal segment could re-point every call at
 * a different path. Only the shape Forge actually issues is accepted.
 */
const SLUG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

/**
 * Resolves the organization slug every API path requires.
 *
 * Resolution is LAZY — deliberately not done during MCP initialize. Resolving at
 * startup would let a Forge outage block the handshake, so the server would fail to
 * connect at all rather than fail one call with a message explaining why. Nothing in
 * the constructor touches the network or throws.
 *
 * Discovery happens at most once: the in-flight promise is shared, so concurrent
 * first calls issue a single `GET /orgs`, and its answer is reused for the life of
 * the process. The deliberate exception is a failure that says nothing final — a
 * transport failure, a 429, a 5xx — which is not cached, so the next tool call may
 * try again. Everything else is a SETTLED verdict and is never re-asked: a verdict
 * *about the organizations* (none, one, several with no FORGE_ORG, or a payload this
 * server cannot understand) cannot change within a process, and neither can a
 * credential verdict — a rejected (401) or unscoped (403) token stays that way for
 * the life of the process.
 */
export class OrganizationResolver {
  readonly #client: ForgeClient;
  readonly #override: string | undefined;
  #discovery: Promise<string> | undefined;

  constructor(client: ForgeClient, orgOverride?: string) {
    this.#client = client;
    // An unset or blank FORGE_ORG means "discover"; a stray newline from a shell
    // profile should not become part of a URL path.
    const trimmed = orgOverride?.trim();
    this.#override = trimmed ? trimmed : undefined;
  }

  async slug(): Promise<string> {
    if (this.#override !== undefined) {
      if (!isUsableInPath(this.#override)) {
        // The value is never echoed back: an operator who pastes the wrong
        // environment variable here must not see it reflected into a transcript.
        throw new ForgeError(
          'FORGE_ORG is not a usable organization slug. It is placed directly into the Forge API path, so it must look like "zenosyne-ltd" — letters, digits, dots, hyphens and underscores only, with no slashes, scheme or ".." segments.',
        );
      }
      return this.#override;
    }
    this.#discovery ??= this.#discover();
    return this.#discovery;
  }

  async #discover(): Promise<string> {
    // Distinguishes "Forge answered, and the answer is final" from "the call did not
    // land" without a second error type: only the former is worth caching.
    let settled = false;
    try {
      const response = await this.#client.request<Envelope<Organization[]>>(
        "GET",
        "/orgs",
      );
      const orgs = response?.data;

      if (!Array.isArray(orgs)) {
        settled = true;
        throw new ForgeError(
          "Forge's response to GET /orgs did not contain an organization list. Set FORGE_ORG to the slug this server should act on.",
        );
      }
      if (orgs.length === 0) {
        settled = true;
        throw new ForgeError(
          "This Forge token can see no organizations, so there is nothing to address.",
        );
      }
      if (orgs.length > 1) {
        settled = true;
        // Defensive: an entry without attributes must not turn a helpful message
        // into a TypeError the agent cannot act on. Entries that name nothing
        // usable are omitted rather than printed as a placeholder — an operator
        // cannot put "unknown" in FORGE_ORG, so saying so plainly is the only
        // actionable answer.
        const identified = orgs
          .map((o) => o?.attributes?.slug ?? o?.id)
          .filter(
            (name): name is string =>
              typeof name === "string" && name.trim() !== "",
          );
        const detail =
          identified.length === orgs.length
            ? ` (${identified.join(", ")})`
            : identified.length === 0
              ? ", none of which could be identified from Forge's response — no entry carried a slug or an id"
              : `, only ${identified.length} of which could be identified from Forge's response (${identified.join(", ")})`;
        throw new ForgeError(
          `This token can see ${orgs.length} organizations${detail}. Set FORGE_ORG to the slug you want this server to act on.`,
        );
      }

      // The single entry gets exactly the defence the multi-org branch gets: a
      // `{"data":[null]}` payload is a verdict about the payload, not a crash, and
      // asking Forge again would produce the same answer every time.
      const slug = orgs[0]?.attributes?.slug;
      if (typeof slug !== "string" || !isUsableInPath(slug)) {
        settled = true;
        throw new ForgeError(
          "Forge's response to GET /orgs did not describe the single visible organization in a way this server understands — its entry carried no slug that can be placed in an API path. Set FORGE_ORG to the slug this server should act on.",
        );
      }
      return slug;
    } catch (error) {
      if (!settled && !isSettledFailure(error)) this.#discovery = undefined;
      throw error;
    }
  }
}

/**
 * A credential verdict cannot change inside this process: a token Forge rejects
 * (401) or that lacks the scope (403) is rejected identically on every later call,
 * so re-asking on every tool call only buys latency. A transport failure, a 429 or a
 * 5xx says nothing final and stays retryable.
 */
function isSettledFailure(error: unknown): boolean {
  return (
    error instanceof ForgeError && (error.status === 401 || error.status === 403)
  );
}

/** Anything that could change the shape of the path it is spliced into is rejected. */
function isUsableInPath(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !slug.includes("..");
}
