import type { ZodRawShape } from "zod";
import type { ForgeClient } from "../client.js";
import type { OrganizationResolver } from "../org.js";
import { getServerTool, listServersTool } from "./servers.js";
import { listSitesTool } from "./sites.js";

/** Everything a tool handler is given. */
export interface ToolContext {
  client: ForgeClient;
  org: OrganizationResolver;
}

/**
 * A tool's definition.
 *
 * `annotations` is not decoration: five of the twelve tools mutate production
 * infrastructure and address it by numeric id, so the read/write split must be
 * machine-readable rather than a naming convention a client has to know about.
 */
export interface ToolDefinition<S extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

/**
 * The registry.
 *
 * Populated per the build order: stage 1 adds list_servers, get_server and
 * list_sites; stage 2 the remaining read tools; stage 3 the five write tools.
 *
 * Order is the order a model sees in tools/list, so it reads as the path a caller
 * actually walks: servers, then one server, then that server's sites.
 */
export const tools: ToolDefinition[] = [
  listServersTool,
  getServerTool,
  listSitesTool,
];
