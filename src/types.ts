/**
 * Narrow types for the responses this server actually reads.
 *
 * Hand-written rather than generated: only twelve tools are exposed, and a generated
 * surface for all 159 API paths would be far larger than anything consumed here.
 */

/** The API wraps resources JSON:API style. */
export interface Envelope<T> {
  data: T;
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

export interface ServerAttributes {
  name: string;
  slug: string;
  ip_address: string | null;
  private_ip_address: string | null;
  region: string | null;
  size: string | null;
  provider: string | null;
  ubuntu_version: string | null;
  php_version: string | null;
  php_cli_version: string | null;
  database_type: string | null;
  /** Health fields — these back get_server_status. */
  connection_status: string | null;
  db_status: string | null;
  redis_status: string | null;
  opcache_status: string | null;
  is_ready: boolean;
  revoked: boolean;
  created_at: string | null;
}

export interface SiteAttributes {
  name: string;
  directory: string | null;
  repository: string | null;
  repository_branch: string | null;
  repository_provider: string | null;
  deployment_status: string | null;
  php_version: string | null;
  created_at: string | null;
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
