/**
 * What the integration smoke test is allowed to do, kept out of the file it governs.
 *
 * The smoke test proves it can never mutate by scanning its OWN source for the names
 * of the mutating tools. That scan cannot work if the list of forbidden names is
 * written in the file being scanned — it would match itself and fail on day one — so
 * the list lives here and the smoke test refers to it by identifier only.
 *
 * The same separation is what makes the check meaningful later: in stage 3 the five
 * mutating tools become real, and the first thing anyone reaching for one from an
 * integration test will do is type its name. That is the moment this catches it.
 */

/** The environment flag that turns the integration smoke test on. */
export const INTEGRATION_FLAG = "FORGE_MCP_INTEGRATION";

/** Whether the caller asked for real Forge calls. Anything but "1" is off. */
export function integrationEnabled(): boolean {
  return process.env[INTEGRATION_FLAG] === "1";
}

/**
 * The read tools the smoke test may call, in the order it calls them.
 *
 * A tool is added here only if `tools/list` advertises it `readOnlyHint: true` — the
 * smoke test asserts exactly that against the live registry before it calls anything,
 * so a tool that changes its annotation cannot stay on this list unnoticed.
 */
export const SMOKE_TEST_TOOLS = [
  "list_servers",
  "get_server",
  "list_sites",
] as const;

/**
 * Every tool the roadmap plans that mutates production infrastructure.
 *
 * Named ahead of their implementation deliberately: the guard has to be in place
 * BEFORE the tools exist, or its first job is a job it was written too late for. The
 * smoke test additionally scans the live registry for anything not annotated
 * read-only, so a mutating tool that arrives under a different name is caught too —
 * this list is the belt, the registry scan is the braces.
 */
export const PLANNED_MUTATING_TOOLS = [
  "deploy_site",
  "reboot_server",
  "reset_deployment_state",
  "toggle_quick_deploy",
  "update_deployment_script",
] as const;

/** Raised when anything asks the read-only transport for a mutating request. */
export class ReadOnlyViolation extends Error {
  constructor(method: string, url: string) {
    super(
      `The integration smoke test attempted ${method} ${url}. It is read-only: ` +
        `it may issue GET and nothing else, against a real Forge account.`,
    );
    this.name = "ReadOnlyViolation";
  }
}

/**
 * Wrap a real `fetch` so that only GET can leave the process.
 *
 * The last line of defence, and the only one that still holds if every other check in
 * the smoke test is deleted: a request that is not a GET never reaches the socket, so
 * no combination of tool wiring, argument or upstream redirect can deploy, reboot or
 * rewrite anything on the account whose token is in the environment.
 */
export function readOnlyTransport(underlying: typeof fetch): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      throw new ReadOnlyViolation(method, String(input));
    }
    return (underlying as (i: unknown, r?: RequestInit) => Promise<Response>)(
      input,
      init,
    );
  }) as unknown as typeof fetch;
}
