import type { ForgeClient } from "./client.js";
import { ForgeError } from "./errors.js";
import type { Envelope, Organization } from "./types.js";

/**
 * Resolves the organization slug every API path requires.
 *
 * Resolution is LAZY — deliberately not done during MCP initialize. Resolving at
 * startup would let a Forge outage block the handshake, so the server would fail to
 * connect at all rather than fail one call with a message explaining why.
 */
export class OrganizationResolver {
  #cached: string | undefined;

  constructor(
    private readonly client: ForgeClient,
    private readonly override?: string,
  ) {}

  async slug(): Promise<string> {
    if (this.override) return this.override;
    if (this.#cached) return this.#cached;

    const response =
      await this.client.request<Envelope<Organization[]>>("GET", "/orgs");
    const orgs = response.data ?? [];

    if (orgs.length === 0) {
      throw new ForgeError(
        "This Forge token can see no organizations, so there is nothing to address.",
      );
    }
    if (orgs.length > 1) {
      const slugs = orgs.map((o) => o.attributes.slug).join(", ");
      throw new ForgeError(
        `This token can see ${orgs.length} organizations (${slugs}). Set FORGE_ORG to the slug you want this server to act on.`,
      );
    }

    this.#cached = orgs[0]!.attributes.slug;
    return this.#cached;
  }
}
