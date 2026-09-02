/**
 * Narrow types for the responses this server actually reads.
 *
 * Hand-written rather than generated: only twelve tools are exposed, and a generated
 * surface for all 159 API paths would be far larger than anything consumed here.
 *
 * `ServerAttributes` and `SiteAttributes` are transcribed from the published
 * `ServerResource` / `SiteResource` schemas rather than guessed — an earlier
 * hand-written `SiteAttributes` named three fields (`directory`,
 * `repository_branch`, `repository_provider`) that the API does not have, which is
 * exactly the kind of drift a type is supposed to prevent. Fields the schema marks
 * required are non-optional here; the schema's nullability is preserved verbatim.
 *
 * These types describe what Forge SAYS it sends. Nothing here is a runtime
 * guarantee, so every value that reaches an agent is still coerced field by field
 * before it leaves a tool.
 */

/** The API wraps a single resource JSON:API style. */
export interface Envelope<T> {
  data: T;
}

/**
 * Cursor pagination, as every Forge list endpoint returns it.
 *
 * `meta` and `links` are marked required by the published schema, but a type is a
 * claim about a remote service: both stay optional here so that a response without
 * them is a missing cursor rather than a TypeError inside a tool handler.
 */
export interface ListEnvelope<T> {
  data: T[];
  links?: {
    first?: string | null;
    last?: string | null;
    prev?: string | null;
    next?: string | null;
  };
  meta?: PaginationMeta;
}

export interface PaginationMeta {
  path: string | null;
  per_page: number;
  /** Non-null means another page exists; it is passed back as `page[cursor]`. */
  next_cursor: string | null;
  prev_cursor: string | null;
}

export interface Resource<A> {
  id: string;
  type: string;
  attributes: A;
}

export interface OrganizationAttributes {
  name: string;
  slug: string;
}

/** Transcribed from `ServerResource.attributes`. */
export interface ServerAttributes {
  id: number;
  credential_id: number | null;
  name: string;
  slug: string;
  /** Forge's `ServerType` enum, e.g. "app". */
  type: string;
  ubuntu_version: string | null;
  ssh_port: number;
  provider: string;
  identifier: string | null;
  size: string;
  region: string;
  php_version: string | null;
  php_cli_version: string | null;
  opcache_status: string | null;
  database_type: string | null;
  db_status: string | null;
  redis_status: string | null;
  ip_address: string | null;
  private_ip_address: string | null;
  revoked: boolean;
  created_at: string;
  updated_at: string;
  connection_status: string | null;
  timezone: string;
  local_public_key: string | null;
  is_ready: boolean;
}

/** The nested repository object — not the flat fields the scaffold assumed. */
export interface SiteRepository {
  provider: string;
  url: string | null;
  branch: string | null;
  /** Forge's `RepositoryStatus` enum. */
  status: string | null;
}

export interface SiteMaintenanceMode {
  enabled: boolean;
  /** Forge's `MaintenanceModeStatus` enum. */
  status: string | null;
}

/** Transcribed from `SiteResource.attributes`. */
export interface SiteAttributes {
  name: string;
  /** Forge's `SiteStatus` enum. */
  status: string;
  url: string;
  user: string;
  https: boolean;
  web_directory: string;
  root_directory: string | null;
  aliases: unknown[];
  php_version: string | null;
  deployment_status: string;
  quick_deploy: boolean | null;
  isolated: boolean;
  /** Linked directories, keyed by path. */
  shared_paths: Record<string, string>;
  repository: SiteRepository;
  database: string | null;
  maintenance_mode: SiteMaintenanceMode;
  zero_downtime_deployments: boolean;
  deployment_retention: number | null;
  deployment_script: string | null;
  wildcards: boolean | null;
  /** Forge's `AppType` enum, or the literal "Custom". */
  app_type: string;
  uses_envoyer: boolean;
  /** The deploy-trigger URL — a secret, and deliberately never returned by a tool. */
  deployment_url: string;
  healthcheck_url: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface DeploymentAttributes {
  commit_hash: string | null;
  commit_message: string | null;
  commit_author: string | null;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export type Organization = Resource<OrganizationAttributes>;
export type Server = Resource<ServerAttributes>;
export type Site = Resource<SiteAttributes>;
export type Deployment = Resource<DeploymentAttributes>;
