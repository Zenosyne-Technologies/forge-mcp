import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { ForgeClient } from "../src/client.js";
import { ForgeError } from "../src/errors.js";
import { OrganizationResolver } from "../src/org.js";
import { tools, type ToolContext } from "../src/tools/index.js";
import { fakeFetch, fixture, type FakeFetch } from "./support/fake-fetch.js";

/**
 * The registry seen through the protocol, not through an import.
 *
 * `src/tools/index.ts` can hold anything; what a client actually receives is what
 * `McpServer.registerTool` made of it. A zod shape the SDK cannot convert, or an
 * annotation it drops, would pass every unit test and still leave the model unable
 * to tell a read tool from a destructive one — so this suite talks to a real server
 * over an in-memory transport and asserts what comes back on the wire.
 *
 * The registration loop below mirrors `src/index.ts`, which performs it inside
 * `main()` and exports nothing; the loop is copied deliberately, and any change to
 * the real one that this does not follow should break these assertions loudly.
 */
const TOKEN = "test-token";

async function connectedClient(forge: FakeFetch): Promise<Client> {
  const apiClient = new ForgeClient({ token: TOKEN, fetchImpl: forge.fetchImpl });
  const ctx: ToolContext = {
    client: apiClient,
    org: new OrganizationResolver(apiClient, "zenosyne-ltd"),
  };

  const server = new McpServer({ name: "forge-mcp", version: "0.1.0" });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(args, ctx);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        } catch (error) {
          const message =
            error instanceof ForgeError
              ? error.message
              : `Unexpected failure in ${tool.name}.`;
          return {
            content: [{ type: "text" as const, text: message }],
            isError: true,
          };
        }
      },
    );
  }

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] })
    .content;
  return content.map((part) => part.text ?? "").join("");
}

describe("tools/list over the protocol", () => {
  it("advertises all three read tools with readOnlyHint: true", async () => {
    const client = await connectedClient(fakeFetch({ body: {} }));

    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);

    expect(names).toContain("list_servers");
    expect(names).toContain("get_server");
    expect(names).toContain("list_sites");
    for (const name of ["list_servers", "get_server", "list_sites"]) {
      const advertised = listed.tools.find((t) => t.name === name);
      expect(advertised?.annotations?.readOnlyHint).toBe(true);
      expect(advertised?.annotations?.destructiveHint).toBe(false);
      expect(advertised?.description).toBeTruthy();
    }
  });

  it("publishes the paging arguments in the advertised input schema", async () => {
    const client = await connectedClient(fakeFetch({ body: {} }));

    const listed = await client.listTools();
    const listServers = listed.tools.find((t) => t.name === "list_servers");
    const properties = listServers?.inputSchema.properties ?? {};

    expect(Object.keys(properties).sort()).toEqual(["cursor", "page_size"]);
    // Neither is required: the first page must cost the model no arguments at all.
    expect(listServers?.inputSchema.required ?? []).toEqual([]);
  });

  it("publishes server_id as the only required argument of the server tools", async () => {
    const client = await connectedClient(fakeFetch({ body: {} }));

    const listed = await client.listTools();

    expect(
      listed.tools.find((t) => t.name === "get_server")?.inputSchema.required,
    ).toEqual(["server_id"]);
    expect(
      listed.tools.find((t) => t.name === "list_sites")?.inputSchema.required,
    ).toEqual(["server_id"]);
  });
});

describe("tools/call over the protocol", () => {
  it("returns parsed servers as JSON text content", async () => {
    const forge = fakeFetch({ body: fixture("servers-page-1") });
    const client = await connectedClient(forge);

    const result = await client.callTool({ name: "list_servers", arguments: {} });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result)) as {
      servers: { id: string; name: string }[];
      next_cursor: string | null;
    };
    expect(payload.servers.map((s) => s.name)).toEqual([
      "app-prod-01",
      "worker-prod-01",
    ]);
    expect(payload.next_cursor).toBe("eyJpZCI6MTAwMn0");
  });

  it("returns the 404 message as an error result rather than a transport failure", async () => {
    const forge = fakeFetch({ status: 404, body: { message: "Not found." } });
    const client = await connectedClient(forge);

    const result = await client.callTool({
      name: "get_server",
      arguments: { server_id: "999999" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Forge has no such resource (404)");
  });
});
