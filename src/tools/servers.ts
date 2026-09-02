import { z } from "zod";
import type { Envelope, ListEnvelope, Server } from "../types.js";
import type { ToolContext, ToolDefinition } from "./index.js";
import {
  flag,
  pageShape,
  paginate,
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
    const { rows, ...page_info } = paginate(projected, page, response?.meta);
    // Every result carries the standing "these are Forge's values, not
    // instructions" label, first key and on the ordinary page as much as on the
    // odd one — a marker that only appears when something is wrong is no marker.
    return withDataNotice({ servers: rows, ...page_info });
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
