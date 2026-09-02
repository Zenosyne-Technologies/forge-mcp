#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ForgeClient } from "./client.js";
import { OrganizationResolver } from "./org.js";
import { renderToolFailure } from "./errors.js";
import { tools, type ToolContext } from "./tools/index.js";

const SERVER_NAME = "forge-mcp";
const SERVER_VERSION = "0.1.0";

async function main(): Promise<void> {
  const client = new ForgeClient({ token: process.env["FORGE_API_KEY"] ?? "" });
  const ctx: ToolContext = {
    client,
    org: new OrganizationResolver(client, process.env["FORGE_ORG"]),
  };

  // McpServer installs the tools/list handler lazily, with the first registerTool
  // call. While the registry is empty the server therefore answers tools/list with
  // "Method not found" and advertises no tools capability — expected, not a fault.
  // Both appear as soon as stage 1 registers a tool.
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

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
          // Surface the actionable message; never the credential, never a stack,
          // and — like the success path above — never raw text that could carry
          // structure of its own. Rendering lives in errors.ts; this is wiring.
          return {
            content: [
              {
                type: "text" as const,
                text: renderToolFailure(error, tool.name),
              },
            ],
            isError: true,
          };
        }
      },
    );
  }

  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; diagnostics go to stderr.
  console.error(
    `${SERVER_NAME} ${SERVER_VERSION} ready on stdio (${tools.length} tools)`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
