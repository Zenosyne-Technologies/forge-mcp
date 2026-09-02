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
 * How many organization names the "which one?" error will actually print.
 *
 * The list exists so an operator can copy one into FORGE_ORG, and nobody copies from
 * a list of two hundred. Forge decides how many entries come back, so without a cap
 * an account with twenty thousand organizations turns one cached error into a
 * hundreds-of-kilobyte string that is replayed into the agent's context on every
 * later tool call. The total is still reported; only the enumeration is bounded.
 */
const MAX_LISTED_ORGANIZATIONS = 10;

/**
 * What discovery concluded, when the conclusion is final.
 *
 * This — never a message, and never an error object built from one — is what the
 * resolver caches. A message is *rendered* from a verdict on every call, so nothing
 * an upstream response said can be retained and replayed into the agent's context.
 * The only strings a verdict may hold are organization names that already passed
 * `isUsableInPath`, capped at `MAX_LISTED_ORGANIZATIONS` entries of 100 characters:
 * a fixed, path-safe budget rather than whatever Forge chose to send.
 */
type Verdict =
  | { kind: "credentials"; status: 401 | 403 }
  | { kind: "malformed" }
  | { kind: "none" }
  | { kind: "unidentifiable-single" }
  | { kind: "ambiguous"; total: number; identified: number; shown: string[] };

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
 * transport failure, a timeout, a 429, a 5xx — which is not cached, so the next tool
 * call may try again. Everything else is a SETTLED verdict and is never re-asked: a
 * verdict *about the organizations* (none, one, several with no FORGE_ORG, or a
 * payload this server cannot understand) cannot change within a process, and neither
 * can a credential verdict — a rejected (401) or unscoped (403) token stays that way
 * for the life of the process.
 *
 * What is cached is the VERDICT, never the rendered message and never the upstream
 * error: a failure is stored as "what kind of failure", and the text an agent reads
 * is rebuilt by `settledError` from that verdict on every call. Otherwise a single
 * 403 whose body carried three hundred kilobytes of attacker-chosen prose would be
 * replayed verbatim into the agent's context on every later tool call, forever, from
 * one upstream request.
 */
export class OrganizationResolver {
  readonly #client: ForgeClient;
  readonly #override: string | undefined;
  #discovery: Promise<string> | undefined;
  #settled: Verdict | undefined;

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
    // A settled verdict answers without a round trip, and answers with a message
    // built here and now rather than one kept from an earlier response.
    if (this.#settled !== undefined) throw settledError(this.#settled);
    this.#discovery ??= this.#discover();
    return this.#discovery;
  }

  async #discover(): Promise<string> {
    try {
      const response = await this.#client.request<Envelope<Organization[]>>(
        "GET",
        "/orgs",
      );
      const orgs = response?.data;

      if (!Array.isArray(orgs)) throw this.#settle({ kind: "malformed" });
      if (orgs.length === 0) throw this.#settle({ kind: "none" });
      if (orgs.length > 1) {
        // Defensive: an entry without attributes must not turn a helpful message
        // into a TypeError the agent cannot act on. Entries that name nothing
        // usable are omitted rather than printed as a placeholder — an operator
        // cannot put "unknown" in FORGE_ORG, so saying so plainly is the only
        // actionable answer.
        //
        // Both the slug and the id are chosen by whoever owns the organization, and
        // this message is read by a model that also holds `reboot_server` and
        // `update_deployment_script`. So the name is FILTERED, not escaped: the only
        // values printed are ones that pass the same predicate FORGE_ORG must pass.
        // A value that fails it could never have been an answer to "set FORGE_ORG to
        // one of these" anyway, and filtering to a known-good shape leaves nothing
        // for a payload — newlines, punctuation, instructions — to survive in.
        const identified = orgs
          .map((o) => o?.attributes?.slug ?? o?.id)
          .filter(
            (name): name is string =>
              typeof name === "string" && isUsableInPath(name),
          );
        throw this.#settle({
          kind: "ambiguous",
          total: orgs.length,
          identified: identified.length,
          // Only what the message will actually print is kept, so the cache holds a
          // fixed number of fixed-length, path-safe names and nothing else.
          shown: identified.slice(0, MAX_LISTED_ORGANIZATIONS),
        });
      }

      // The single entry gets exactly the defence the multi-org branch gets: a
      // `{"data":[null]}` payload is a verdict about the payload, not a crash, and
      // asking Forge again would produce the same answer every time.
      const slug = orgs[0]?.attributes?.slug;
      if (typeof slug !== "string" || !isUsableInPath(slug)) {
        throw this.#settle({ kind: "unidentifiable-single" });
      }
      return slug;
    } catch (error) {
      // The shared in-flight promise is finished with either way, and dropping it is
      // what keeps the upstream rejection from being retained and re-awaited: the
      // verdict cache, not a stale rejected promise, is what stops a re-ask.
      this.#discovery = undefined;
      if (this.#settled !== undefined) throw error;

      // A credential verdict cannot change inside this process, so it settles — but
      // it settles as a status code, not as the message Forge's body produced.
      const status = error instanceof ForgeError ? error.status : undefined;
      if (status === 401 || status === 403) {
        throw this.#settle({ kind: "credentials", status });
      }
      // A transport failure, a timeout, a 429 or a 5xx says nothing final: it is not
      // cached, so the next tool call tries again.
      throw error;
    }
  }

  /** Records a final verdict and returns the error to throw for it. */
  #settle(verdict: Verdict): ForgeError {
    this.#settled = verdict;
    return settledError(verdict);
  }
}

/**
 * Renders a verdict into the message an agent reads.
 *
 * Every branch is authored here, in this repository. Nothing an upstream response
 * said — not a body, not a header, not an error string — reaches this function, so a
 * cached verdict cannot become a channel for replaying upstream text.
 */
function settledError(verdict: Verdict): ForgeError {
  switch (verdict.kind) {
    case "credentials":
      return verdict.status === 401
        ? new ForgeError(
            "Forge rejected the API token (401) when this server looked up the organization, so no Forge call can succeed in this process. The token is missing, invalid or expired — issue a new one at https://forge.laravel.com/profile/api, set FORGE_API_KEY, and restart this server.",
            401,
          )
        : new ForgeError(
            "Forge refused this server's organization lookup (403), so no Forge call can succeed in this process. The token is valid but lacks the scope that lookup needs — grant it organization access or set FORGE_ORG to the slug this server should act on, then restart this server.",
            403,
          );
    case "malformed":
      return new ForgeError(
        "Forge's response to GET /orgs did not contain an organization list. Set FORGE_ORG to the slug this server should act on.",
      );
    case "none":
      return new ForgeError(
        "This Forge token can see no organizations, so there is nothing to address.",
      );
    case "unidentifiable-single":
      return new ForgeError(
        "Forge's response to GET /orgs did not describe the single visible organization in a way this server understands — its entry carried no slug that can be placed in an API path. Set FORGE_ORG to the slug this server should act on.",
      );
    case "ambiguous": {
      const detail =
        verdict.identified === verdict.total
          ? ` (${renderNames(verdict.shown, verdict.identified)})`
          : verdict.identified === 0
            ? ", none of which could be identified from Forge's response — no entry carried a slug or an id this server can place in an API path"
            : `, only ${verdict.identified} of which could be identified from Forge's response (${renderNames(verdict.shown, verdict.identified)})`;
      return new ForgeError(
        `This token can see ${verdict.total} organizations${detail}. Set FORGE_ORG to the slug you want this server to act on.`,
      );
    }
  }
}

/** Anything that could change the shape of the path it is spliced into is rejected. */
function isUsableInPath(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !slug.includes("..");
}

/**
 * Prints the (at most `MAX_LISTED_ORGANIZATIONS`) names kept and counts the rest.
 *
 * `isUsableInPath` already bounds one name to 100 characters, so capping the count
 * is what bounds the whole string — together they keep this error a fixed size no
 * matter what Forge returns.
 */
function renderNames(shown: string[], identified: number): string {
  const listed = shown.join(", ");
  if (identified <= MAX_LISTED_ORGANIZATIONS) return listed;
  return `${listed}, and ${identified - MAX_LISTED_ORGANIZATIONS} more`;
}
