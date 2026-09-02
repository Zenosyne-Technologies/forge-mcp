import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { ForgeClient } from "../src/client.js";
import { OrganizationResolver } from "../src/org.js";
import { tools, type ToolContext } from "../src/tools/index.js";
import { realFetch } from "./support/network-guard.js";
import {
  INTEGRATION_FLAG,
  PLANNED_MUTATING_TOOLS,
  ReadOnlyViolation,
  SMOKE_TEST_TOOLS,
  integrationEnabled,
  readOnlyTransport,
} from "./support/read-only.js";

/**
 * The one suite that talks to a real Forge account — off unless asked for.
 *
 * Everything else in this directory runs against recorded fixtures and cannot reach
 * the network at all. That proves this server parses what Forge sent on the day the
 * fixtures were captured; it cannot prove Forge still sends it. This file closes that
 * gap, and pays for it by being opt-in:
 *
 *     FORGE_MCP_INTEGRATION=1 FORGE_API_KEY=… npm run test:integration
 *
 * Without the flag its calls are reported as SKIPPED, not omitted — a suite that
 * simply is not there when the flag is off is a suite everyone forgets exists, and a
 * `0 skipped` line is the only thing that distinguishes "we chose not to run it" from
 * "it silently stopped being collected".
 *
 * READ-ONLY, THREE WAYS. This account is somebody's production infrastructure, and
 * the only thing between a staging server and a production one is a numeric id. So:
 *
 *   1. Every tool it calls is asserted `readOnlyHint: true` against the live registry
 *      before any call is made — and those assertions run even when the flag is off.
 *   2. Its own source is scanned for the name of every tool that mutates, planned or
 *      already registered. Adding a call to one in stage 3 fails this file, in this
 *      file, immediately.
 *   3. Its transport refuses any method but GET, so a mutating request cannot leave
 *      the process even if the first two are somehow satisfied.
 *
 * The token comes from `FORGE_API_KEY` and is never printed: nothing here logs, and
 * `ForgeClient` hands the credential to `describeHttpFailure` so that an upstream
 * error body reflecting it is redacted before it can reach an assertion message.
 */

const ENABLED = integrationEnabled();
const SOURCE = readFileSync(fileURLToPath(import.meta.url), "utf8");

/** A live account can be slow; this is not a unit test's budget. */
const LIVE_TIMEOUT_MS = 60_000;

function liveContext(): ToolContext {
  const client = new ForgeClient({
    token: process.env["FORGE_API_KEY"] ?? "",
    // The global `fetch` is the suite-wide refusal installed by
    // `test/support/setup.ts`. This is the one place entitled to the real one, and it
    // only ever gets it wrapped in the read-only transport.
    fetchImpl: readOnlyTransport(realFetch),
  });
  return {
    client,
    org: new OrganizationResolver(client, process.env["FORGE_ORG"]),
  };
}

async function call(
  name: (typeof SMOKE_TEST_TOOLS)[number],
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} is not registered`);
  expect(tool.annotations.readOnlyHint).toBe(true);
  return tool.handler(args, liveContext());
}

/**
 * These run on every `npm test`, flag or no flag.
 *
 * The guarantees are about what this file COULD do, so they are worthless if they
 * only hold on the runs where it does it.
 */
describe("integration smoke — the read-only guarantees", () => {
  it("only ever names tools the registry advertises as read-only", () => {
    for (const name of SMOKE_TEST_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);

      expect(
        tool,
        `${name} is on the smoke-test list but not registered`,
      ).toBeDefined();
      expect(tool?.annotations.readOnlyHint).toBe(true);
      expect(tool?.annotations.destructiveHint).toBe(false);
    }
  });

  it("does not mention any tool the roadmap plans as a mutating one", () => {
    for (const name of PLANNED_MUTATING_TOOLS) {
      expect(
        SOURCE.includes(name),
        `This file references ${name}, which mutates production infrastructure. The integration smoke test is read-only — call it from a fixture-backed suite instead.`,
      ).toBe(false);
    }
  });

  it("does not mention any registered tool that is not annotated read-only", () => {
    const mutating = tools.filter(
      (tool) => tool.annotations.readOnlyHint !== true,
    );

    for (const tool of mutating) {
      expect(
        SOURCE.includes(tool.name),
        `This file references ${tool.name}, which is registered without readOnlyHint: true.`,
      ).toBe(false);
    }
  });

  it("refuses every method but GET at the transport, before anything leaves", async () => {
    const transport = readOnlyTransport(realFetch);

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await expect(
        transport("https://forge.laravel.com/api/orgs", { method }),
      ).rejects.toBeInstanceOf(ReadOnlyViolation);
    }
  });

  it("requires a token in the environment when the flag is on", () => {
    if (!ENABLED) return;

    expect(
      (process.env["FORGE_API_KEY"] ?? "").length,
      `${INTEGRATION_FLAG}=1 was set but FORGE_API_KEY is empty. The smoke test reads its credential from the environment and takes it from nowhere else.`,
    ).toBeGreaterThan(0);
  });
});

/**
 * The live calls. Reported as skipped unless the flag is set.
 *
 * Deliberately shallow: this asks whether the current Forge API still answers the
 * three stage-1 read paths in the shape this server parses. What each field means and
 * every edge around it is the fixture suites' job, and duplicating them here would
 * make a network-dependent copy of assertions that already run everywhere.
 */
describe(`integration smoke — live Forge, read-only (set ${INTEGRATION_FLAG}=1 to run)`, () => {
  /** Carried between the calls: `get_server` needs an id `list_servers` returned. */
  let serverId: string | null = null;
  let serverCount = 0;
  /**
   * Whether the first call completed at all.
   *
   * Without this the cascade passes vacuously: a `list_servers` that fails leaves
   * `serverId` null, and the two tests that follow would read that as "the account
   * has no servers" and assert nothing. They must fail with the reason instead.
   */
  let listed = false;

  beforeAll(() => {
    if (!ENABLED) return;
    expect(process.env["FORGE_API_KEY"] ?? "").not.toBe("");
  });

  it.skipIf(!ENABLED)(
    "list_servers answers from the live API in the shape this server parses",
    async () => {
      const result = (await call("list_servers", { page_size: 5 })) as {
        servers: { id: string | null; name: string | null }[];
        count: number;
        has_more: boolean;
        data_notice: string;
      };

      expect(Array.isArray(result.servers)).toBe(true);
      expect(result.count).toBe(result.servers.length);
      expect(typeof result.has_more).toBe("boolean");
      expect(result.data_notice.length).toBeGreaterThan(0);

      serverCount = result.servers.length;
      serverId = result.servers[0]?.id ?? null;
      listed = true;
    },
    LIVE_TIMEOUT_MS,
  );

  it.skipIf(!ENABLED)(
    "get_server returns the same server list_servers described",
    async () => {
      expect(
        listed,
        "list_servers did not complete, so there is no server to fetch",
      ).toBe(true);
      if (serverId === null) {
        // Nothing to fetch is a legitimate account state, not a silent pass: assert
        // that it is the reason, so an id that went missing for any other reason
        // fails here instead of skipping the check.
        expect(serverCount).toBe(0);
        return;
      }

      const result = (await call("get_server", { server_id: serverId })) as {
        server: { id: string | null };
        data_notice: string;
      };

      expect(result.server.id).toBe(serverId);
      expect(result.data_notice.length).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );

  it.skipIf(!ENABLED)(
    "list_sites answers for a server the live account actually has",
    async () => {
      expect(
        listed,
        "list_servers did not complete, so there is no server to list sites for",
      ).toBe(true);
      if (serverId === null) {
        expect(serverCount).toBe(0);
        return;
      }

      const result = (await call("list_sites", {
        server_id: serverId,
        page_size: 5,
      })) as { sites: unknown[]; count: number; data_notice: string };

      expect(Array.isArray(result.sites)).toBe(true);
      expect(result.count).toBe(result.sites.length);
      expect(result.data_notice.length).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );

  it.skipIf(!ENABLED)(
    "never renders the credential into a result or an error",
    async () => {
      const token = process.env["FORGE_API_KEY"] ?? "";
      const rendered = await call("list_servers", { page_size: 1 }).then(
        (result) => JSON.stringify(result),
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

      expect(token.length).toBeGreaterThan(0);
      expect(rendered.includes(token)).toBe(false);
    },
    LIVE_TIMEOUT_MS,
  );
});
