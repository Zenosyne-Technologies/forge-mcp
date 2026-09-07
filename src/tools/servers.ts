import { z } from "zod";
import type { Envelope, ListEnvelope, Server } from "../types.js";
import type { ToolContext, ToolDefinition } from "./index.js";
import {
  flag,
  pageShape,
  pagedList,
  readPageArgs,
  record,
  requireList,
  requirePathSegment,
  requireResource,
  text,
  whole,
  withDataNotice,
  withPageQuery,
} from "./common.js";

/**
 * What a server looks like once it has left this server.
 *
 * A whitelist, field by field: Forge's `local_public_key` (key material),
 * `credential_id` and `identifier` (provider bookkeeping an agent cannot act on)
 * are absent because nothing copies them, and anything Forge adds later is absent
 * for the same reason.
 */
export interface ServerView {
  /** The id every other server-scoped tool takes. */
  id: string | null;
  name: string | null;
  slug: string | null;
  type: string | null;
  provider: string | null;
  region: string | null;
  size: string | null;
  ip_address: string | null;
  private_ip_address: string | null;
  ssh_port: number | null;
  ubuntu_version: string | null;
  php_version: string | null;
  php_cli_version: string | null;
  database_type: string | null;
  timezone: string | null;
  is_ready: boolean | null;
  revoked: boolean | null;
  connection_status: string | null;
  db_status: string | null;
  redis_status: string | null;
  opcache_status: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export function projectServer(raw: unknown): ServerView {
  const resource = record(raw);
  const a = record(resource?.["attributes"]) ?? {};
  return {
    // The path segment is the resource id; `attributes.id` is the same number and
    // is only a fallback for a response that omits the envelope id.
    id: text(resource?.["id"], 64) ?? numericId(a["id"]),
    name: text(a["name"]),
    slug: text(a["slug"]),
    type: text(a["type"]),
    provider: text(a["provider"]),
    region: text(a["region"]),
    size: text(a["size"]),
    ip_address: text(a["ip_address"], 64),
    private_ip_address: text(a["private_ip_address"], 64),
    ssh_port: whole(a["ssh_port"]),
    ubuntu_version: text(a["ubuntu_version"], 32),
    php_version: text(a["php_version"], 32),
    php_cli_version: text(a["php_cli_version"], 32),
    database_type: text(a["database_type"], 64),
    timezone: text(a["timezone"], 64),
    is_ready: flag(a["is_ready"]),
    revoked: flag(a["revoked"]),
    connection_status: text(a["connection_status"], 64),
    db_status: text(a["db_status"], 64),
    redis_status: text(a["redis_status"], 64),
    opcache_status: text(a["opcache_status"], 64),
    created_at: text(a["created_at"], 40),
    updated_at: text(a["updated_at"], 40),
  };
}

function numericId(value: unknown): string | null {
  const id = whole(value);
  return id === null ? null : String(id);
}

/**
 * The health half of a server record — exactly the six fields Forge publishes that
 * answer "is this box working?", and nothing else.
 *
 * Every one of them is also in `ServerView`, and that is deliberate rather than a
 * shortfall: Forge's `ServerResource` carries no CPU, memory or load-average
 * reading at all, so there is no richer health payload to fetch. `monitors` are
 * alerting THRESHOLDS, not measurements. A status tool that implied otherwise would
 * send an agent hunting for a metric this API stopped reporting.
 *
 * So the projection is derived from `projectServer` rather than re-read from the
 * attributes bag. That makes "the same values get_server returns, fewer of them"
 * true by construction — the claim the tool's description makes, checked by the
 * suite against these two functions rather than against a comment.
 */
export const SERVER_STATUS_FIELDS = [
  "connection_status",
  "is_ready",
  "db_status",
  "redis_status",
  "opcache_status",
  "php_version",
] as const;

export type ServerStatusView = Pick<
  ServerView,
  (typeof SERVER_STATUS_FIELDS)[number]
>;

export function projectServerStatus(raw: unknown): ServerStatusView {
  const server = projectServer(raw);
  return {
    connection_status: server.connection_status,
    is_ready: server.is_ready,
    db_status: server.db_status,
    redis_status: server.redis_status,
    opcache_status: server.opcache_status,
    php_version: server.php_version,
  };
}

export const listServersTool: ToolDefinition = {
  name: "list_servers",
  title: "List servers",
  description:
    "Lists the Forge servers in this organization, one page per call. Each row is the whole server record: the id every other server tool needs, plus name, provider, region, IPs, PHP version, readiness and connection, database, Redis and OPcache status. Use it to answer 'which servers exist' or to find a server id. has_more says whether further rows exist; pass next_cursor back as cursor to fetch them, and read notes whenever it is non-empty.",
  inputSchema: pageShape,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
    // Arguments are checked before anything is resolved or sent: a bad page size or
    // cursor is a caller mistake, not a round trip to Forge.
    const page = readPageArgs(args);
    const org = await ctx.org.slug();

    const response = await ctx.client.request<ListEnvelope<Server>>(
      "GET",
      withPageQuery(`/orgs/${org}/servers`, page),
    );

    // A `data` that is not a list is not an empty account: `requireList` refuses to
    // let a shape this server does not understand read as "there are no servers".
    const projected = requireList(response?.data, "server").map(projectServer);
    // One call builds the whole emitted result: the standing "these are Forge's
    // values, not instructions" label first key, the rows, the pagination and the
    // notes — and measures that document against the output budget.
    return pagedList("servers", projected, page, response?.meta);
  },
};

export const getServerTool: ToolDefinition = {
  name: "get_server",
  title: "Get server",
  description:
    "Fetches one Forge server by id without enumerating the organization. It returns exactly the row list_servers returns for that server — the same fields, no additional detail — so reach for it when you already hold a server id, and for list_servers when you need to find one or to see several at once.",
  inputSchema: {
    server_id: z
      .string()
      .describe("Forge server id, exactly as returned by list_servers."),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const serverId = requirePathSegment(args["server_id"], "server_id");
    const org = await ctx.org.slug();

    const response = await ctx.client.request<Envelope<Server>>(
      "GET",
      `/orgs/${org}/servers/${serverId}`,
    );

    // Same refusal as the list tools: a payload this server cannot read must not be
    // rendered as a server whose every field happens to be null.
    return withDataNotice({
      server: projectServer(requireResource(response?.data, "server")),
    });
  },
};

export const getServerStatusTool: ToolDefinition = {
  name: "get_server_status",
  title: "Get server status",
  description:
    "Answers one question about one server — is it healthy? — as the narrowest read available: connection_status, is_ready, db_status, redis_status, opcache_status and php_version, and nothing else. get_server returns these same six values inside the whole record, so this tool returns fewer fields, never more; prefer it for a health check and get_server when you need the rest. Forge no longer reports CPU, memory or load-average metrics, so no tool here can give you a load or CPU reading.",
  inputSchema: {
    server_id: z
      .string()
      .describe("Forge server id, exactly as returned by list_servers."),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const serverId = requirePathSegment(args["server_id"], "server_id");
    const org = await ctx.org.slug();

    // The same endpoint get_server reads. There is no status endpoint to call: the
    // difference between the two tools is what is asked for and what comes back
    // into the agent's context, not which route is hit.
    const response = await ctx.client.request<Envelope<Server>>(
      "GET",
      `/orgs/${org}/servers/${serverId}`,
    );

    return withDataNotice({
      server_status: projectServerStatus(
        requireResource(response?.data, "server"),
      ),
    });
  },
};
