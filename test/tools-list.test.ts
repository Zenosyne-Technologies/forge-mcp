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
  it("advertises every read tool with readOnlyHint: true", async () => {
    const client = await connectedClient(fakeFetch({ body: {} }));

    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);

    expect(names).toEqual([
      "list_servers",
      "get_server",
      "get_server_status",
      "list_sites",
      "get_site",
      "get_deployments",
      "get_deployment_script",
    ]);
    for (const name of names) {
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
      listed.tools.find((t) => t.name === "get_server_status")?.inputSchema
        .required,
    ).toEqual(["server_id"]);
    expect(
      listed.tools.find((t) => t.name === "list_sites")?.inputSchema.required,
    ).toEqual(["server_id"]);
  });

  it("publishes both ids as required on the two deployment tools", async () => {
    const client = await connectedClient(fakeFetch({ body: {} }));

    const listed = await client.listTools();
    const deployments = listed.tools.find((t) => t.name === "get_deployments");
    const script = listed.tools.find((t) => t.name === "get_deployment_script");

    // Both are server-scoped AND site-scoped: unlike get_site, neither can resolve
    // a site from its id alone, so a model that is handed only one of the two ids
    // has to be told to go and find the other rather than guess it.
    expect((deployments?.inputSchema.required ?? []).slice().sort()).toEqual([
      "server_id",
      "site_id",
    ]);
    expect(Object.keys(deployments?.inputSchema.properties ?? {}).sort()).toEqual(
      ["cursor", "page_size", "server_id", "site_id"],
    );

    expect((script?.inputSchema.required ?? []).slice().sort()).toEqual([
      "server_id",
      "site_id",
    ]);
    // A detail read: no paging arguments to advertise, so none are published.
    expect(Object.keys(script?.inputSchema.properties ?? {}).sort()).toEqual([
      "server_id",
      "site_id",
    ]);
  });

  it("publishes site_id as get_site's only argument, required and alone", async () => {
    const client = await connectedClient(fakeFetch({ body: {} }));

    const listed = await client.listTools();
    const getSite = listed.tools.find((t) => t.name === "get_site");

    // On the wire, not merely in the registry: a server_id advertised here would
    // make a model ask for one it does not need and may not have.
    expect(Object.keys(getSite?.inputSchema.properties ?? {})).toEqual([
      "site_id",
    ]);
    expect(getSite?.inputSchema.required).toEqual(["site_id"]);
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

  it("returns one site addressed by site id alone", async () => {
    const forge = fakeFetch({ body: fixture("site-single") });
    const client = await connectedClient(forge);

    const result = await client.callTool({
      name: "get_site",
      arguments: { site_id: "5001" },
    });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result)) as { site: { name: string } };
    expect(payload.site.name).toBe("zenosyne.tech");
    expect(forge.calls[0]?.url).toContain("/orgs/zenosyne-ltd/sites/5001");
    // The compound document's side-load does not survive the trip to the client.
    expect(textOf(result)).not.toContain("local_public_key");
  });

  it("returns a deployment script as text content, lines and all", async () => {
    const forge = fakeFetch({ body: fixture("deployment-script-single") });
    const client = await connectedClient(forge);

    const result = await client.callTool({
      name: "get_deployment_script",
      arguments: { server_id: "1001", site_id: "5001" },
    });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result)) as {
      deployment_script: { content: string; auto_source: boolean };
    };
    // Over the wire, through the SDK, out the other side: still separate lines,
    // and still the fixture's own bytes — the indentation inside the artisan block
    // included, because JSON carries a leading run of spaces as faithfully as it
    // carries the newline before it.
    expect(payload.deployment_script.content.split("\n")).toContain(
      "    php artisan queue:restart",
    );
    expect(payload.deployment_script.content).toBe(
      fixture<{ data: { attributes: { content: string } } }>(
        "deployment-script-single",
      ).data.attributes.content,
    );
    expect(payload.deployment_script.auto_source).toBe(true);
    expect(forge.calls[0]?.url).toContain(
      "/servers/1001/sites/5001/deployments/script",
    );
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
