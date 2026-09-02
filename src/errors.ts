/**
 * Errors surfaced to the agent.
 *
 * Every message must be actionable and must NEVER contain the API token: this server
 * is driven by a model whose output is transcribed, so a credential echoed into an
 * error becomes a credential in a log.
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

function extractMessage(body: unknown): string | undefined {
  if (typeof body === "string" && body.trim()) return body.slice(0, 300);
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record["message"] === "string") return record["message"];
    if (record["errors"]) return JSON.stringify(record["errors"]).slice(0, 300);
  }
  return undefined;
}
