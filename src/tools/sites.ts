import { z } from "zod";
import type { ListEnvelope, Site } from "../types.js";
import type { ToolContext, ToolDefinition } from "./index.js";
import {
  flag,
  items,
  pageShape,
  readPageArgs,
  readPageInfo,
  record,
  requirePathSegment,
  text,
  textList,
  url,
  withPageQuery,
} from "./common.js";

/**
 * What a site looks like once it has left this server.
 *
 * Two omissions are deliberate rather than incidental. `deployment_url` is the
 * deploy-trigger secret — anyone holding it can deploy the site, so it must not be
 * transcribed into an agent's context. `deployment_script` and `shared_paths` are
 * unbounded operator-authored blobs; they belong to a tool asked for one site's
 * script, not to a listing that returns fifty rows at a time.
 */
export interface SiteView {
  /** The id every other site-scoped tool takes. */
  id: string | null;
  name: string | null;
  status: string | null;
  url: string | null;
  https: boolean | null;
  app_type: string | null;
  deployment_status: string | null;
  quick_deploy: boolean | null;
  zero_downtime_deployments: boolean | null;
  web_directory: string | null;
  root_directory: string | null;
  aliases: string[];
  repository: {
    provider: string | null;
    url: string | null;
    branch: string | null;
    status: string | null;
  };
  database: string | null;
  php_version: string | null;
  user: string | null;
  isolated: boolean | null;
  maintenance_mode: { enabled: boolean | null; status: string | null };
  uses_envoyer: boolean | null;
  healthcheck_url: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export function projectSite(raw: unknown): SiteView {
  const resource = record(raw);
  const a = record(resource?.["attributes"]) ?? {};
  const repository = record(a["repository"]) ?? {};
  const maintenance = record(a["maintenance_mode"]) ?? {};
  return {
    id: text(resource?.["id"], 64),
    name: text(a["name"]),
    status: text(a["status"], 64),
    url: url(a["url"]),
    https: flag(a["https"]),
    app_type: text(a["app_type"], 64),
    deployment_status: text(a["deployment_status"], 64),
    quick_deploy: flag(a["quick_deploy"]),
    zero_downtime_deployments: flag(a["zero_downtime_deployments"]),
    web_directory: url(a["web_directory"]),
    root_directory: url(a["root_directory"]),
    aliases: textList(a["aliases"]),
    repository: {
      provider: text(repository["provider"], 64),
      url: url(repository["url"]),
      branch: text(repository["branch"]),
      status: text(repository["status"], 64),
    },
    database: text(a["database"]),
    php_version: text(a["php_version"], 32),
    user: text(a["user"], 64),
    isolated: flag(a["isolated"]),
    maintenance_mode: {
      enabled: flag(maintenance["enabled"]),
      status: text(maintenance["status"], 64),
    },
    uses_envoyer: flag(a["uses_envoyer"]),
    healthcheck_url: url(a["healthcheck_url"]),
    created_at: text(a["created_at"], 40),
    updated_at: text(a["updated_at"], 40),
  };
}

export const listSitesTool: ToolDefinition = {
  name: "list_sites",
  title: "List sites",
  description:
    "Lists the sites hosted on one Forge server: site id, domain, URL, app type, repository provider/branch and deployment status. Use it to find a site id, or to see what a server actually serves; get the server id from list_servers first. Returns one page: if next_cursor is not null, more sites exist and passing it back as cursor fetches the next page.",
  inputSchema: {
    server_id: z
      .string()
      .describe("Forge server id, exactly as returned by list_servers."),
    ...pageShape,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
    // Both the id and the paging arguments are settled before anything is sent.
    const serverId = requirePathSegment(args["server_id"], "server_id");
    const page = readPageArgs(args);
    const org = await ctx.org.slug();

    const response = await ctx.client.request<ListEnvelope<Site>>(
      "GET",
      withPageQuery(`/orgs/${org}/servers/${serverId}/sites`, page),
    );

    const sites = items(response?.data).map(projectSite);
    return { sites, count: sites.length, ...readPageInfo(response?.meta) };
  },
};
