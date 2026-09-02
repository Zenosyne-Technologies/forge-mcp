/**
 * Errors surfaced to the agent.
 *
 * Every message must be actionable and must NEVER contain the API token: this server
 * is driven by a model whose output is transcribed, so a credential echoed into an
 * error becomes a credential in a log.
 *
 * Messages also quote text Forge wrote, and that text is upstream-controlled. It
 * lands in the context of a model that can reboot servers and rewrite deployment
 * scripts, so an error body is a prompt-injection channel: unbounded it floods the
 * context, and with its newlines intact it can forge document structure — a fake
 * "=== END OF TOOL OUTPUT ===" block reads as a new section rather than as data.
 * Every fragment quoted from Forge is therefore bounded to one consistent length,
 * flattened to a single line, and labelled as reported text before it is used.
 */
export class ForgeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ForgeError";
  }
}

/**
 * The one bound on any fragment of upstream text this server quotes back.
 *
 * It applies to every branch of `extractMessage` — a single uncapped branch is the
 * whole defect, so there is exactly one number and no branch may opt out of it.
 */
export const MAX_UPSTREAM_DETAIL = 300;

/** The label that marks a fragment as Forge's words rather than this server's. */
export const UPSTREAM_LABEL = "Forge said:";

/**
 * Everything that could make upstream text read as structure: C0 controls (newline,
 * carriage return, tab, NUL and ESC among them), DEL, the C1 range (NEL included),
 * and the Unicode line and paragraph separators.
 */
const STRUCTURE_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

/** Turn an HTTP failure into something an agent can act on. */
export function describeHttpFailure(
  status: number,
  path: string,
  body: unknown,
): string {
  const detail = extractMessage(body);
  switch (status) {
    case 401:
      return "Forge rejected the API token (401). It is missing, invalid, or expired — issue a new one at https://forge.laravel.com/profile/api and set FORGE_API_KEY.";
    case 403:
      return `Forge refused the request (403)${detail ? `: ${detail}` : ""}. The token is valid but lacks the scope this call needs.`;
    case 404:
      return `Forge has no such resource (404) at ${path}${detail ? `: ${detail}` : ""}. Check the organization slug and the server/site identifiers.`;
    case 422:
      return `Forge rejected the request body (422)${detail ? `: ${detail}` : ""}.`;
    case 429:
      return "Forge rate-limited the request (429). Wait for the retry-after window before trying again.";
    default:
      return `Forge returned ${status} for ${path}${detail ? `: ${detail}` : ""}.`;
  }
}

/**
 * The text a failed tool result carries.
 *
 * The success path renders through JSON.stringify and is therefore incapable of
 * emitting a literal newline; the error path goes through here so that it is
 * incapable of one too, whoever authored the message. Defence at the render
 * boundary, not only at the source.
 */
export function renderToolFailure(error: unknown, toolName: string): string {
  const message =
    error instanceof ForgeError
      ? error.message
      : `Unexpected failure in ${toolName}.`;
  return JSON.stringify(message);
}

function extractMessage(body: unknown): string | undefined {
  if (typeof body === "string") return quoteUpstream(body);
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record["message"] === "string")
      return quoteUpstream(record["message"]);
    if (record["errors"]) {
      const encoded = JSON.stringify(record["errors"]);
      if (typeof encoded === "string") return quoteUpstream(encoded);
    }
  }
  return undefined;
}

/**
 * Bound, flatten and label one fragment of Forge's own words.
 *
 * The fragment keeps its diagnostic value — "No query results for model
 * [App\Models\Server]" is exactly what an agent needs — while losing every means of
 * pretending to be anything other than quoted data.
 */
function quoteUpstream(raw: string): string | undefined {
  const flattened = raw
    .replace(STRUCTURE_CHARS, " ")
    // A quoted fragment must not be able to close its own quote, and the delimiter
    // stays readable if it never has to be escaped.
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!flattened) return undefined;

  const bounded =
    flattened.length > MAX_UPSTREAM_DETAIL
      ? `${flattened.slice(0, MAX_UPSTREAM_DETAIL - 1)}…`
      : flattened;
  return `${UPSTREAM_LABEL} "${bounded}"`;
}
