import { describe, expect, it } from "vitest";

import { ForgeClient } from "../src/client.js";
import { ForgeError } from "../src/errors.js";
import { OrganizationResolver } from "../src/org.js";
import { fakeFetch, fixture, unreachableFetch } from "./support/fake-fetch.js";

/** Obviously fake. A real Forge credential never enters this repository. */
const TOKEN = "test-token";

const ORGS_URL = "https://forge.laravel.com/api/orgs";

function resolverFor(
  fetchImpl: typeof fetch,
  orgOverride?: string,
): OrganizationResolver {
  return new OrganizationResolver(
    new ForgeClient({ token: TOKEN, fetchImpl }),
    orgOverride,
  );
}

describe("OrganizationResolver — discovery", () => {
  it("resolves a single visible organization with no FORGE_ORG set", async () => {
    const forge = fakeFetch({ body: fixture("orgs-single") });

    await expect(resolverFor(forge.fetchImpl).slug()).resolves.toBe(
      "zenosyne-ltd",
    );
    expect(forge.calls).toEqual([{ url: ORGS_URL, method: "GET" }]);
  });

  it("names the available slugs when several organizations are visible", async () => {
    const forge = fakeFetch({ body: fixture("orgs-multiple") });

    const failure = await resolverFor(forge.fetchImpl)
      .slug()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ForgeError);
    const message = (failure as ForgeError).message;
    expect(message).toContain("zenosyne-ltd");
    expect(message).toContain("example-agency");
    expect(message).toContain("FORGE_ORG");
  });

  it("explains that a token seeing no organizations has nothing to address", async () => {
    const forge = fakeFetch({ body: fixture("orgs-empty") });

    await expect(resolverFor(forge.fetchImpl).slug()).rejects.toThrow(
      ForgeError,
    );
  });

  it("rejects a malformed /orgs payload instead of building a broken path", async () => {
    const forge = fakeFetch({ body: { data: { slug: "zenosyne-ltd" } } });

    await expect(resolverFor(forge.fetchImpl).slug()).rejects.toThrow(
      ForgeError,
    );
  });

  it("rejects a discovered slug that would alter the path shape", async () => {
    const forge = fakeFetch({
      body: {
        data: [
          {
            id: "org-1",
            type: "organization",
            attributes: { name: "Zenosyne Ltd.", slug: "../admin" },
          },
        ],
      },
    });

    await expect(resolverFor(forge.fetchImpl).slug()).rejects.toThrow(
      ForgeError,
    );
  });
});

describe("OrganizationResolver — FORGE_ORG override", () => {
  it("bypasses the discovery call entirely", async () => {
    const forge = fakeFetch(new Error("discovery must not be attempted"));

    await expect(
      resolverFor(forge.fetchImpl, "zenosyne-ltd").slug(),
    ).resolves.toBe("zenosyne-ltd");
    expect(forge.calls).toHaveLength(0);
  });

  it("trims surrounding whitespace picked up from a shell profile", async () => {
    const forge = fakeFetch(new Error("discovery must not be attempted"));

    await expect(
      resolverFor(forge.fetchImpl, " zenosyne-ltd\n").slug(),
    ).resolves.toBe("zenosyne-ltd");
    expect(forge.calls).toHaveLength(0);
  });

  it("treats a blank override as unset and discovers instead", async () => {
    const forge = fakeFetch({ body: fixture("orgs-single") });

    await expect(resolverFor(forge.fetchImpl, "   ").slug()).resolves.toBe(
      "zenosyne-ltd",
    );
    expect(forge.calls).toHaveLength(1);
  });

  it.each([
    ["a leading slash", "/zenosyne-ltd"],
    ["an extra path segment", "zenosyne-ltd/servers"],
    ["a traversal", "../../admin"],
    ["a bare traversal", ".."],
    ["an embedded traversal", "zeno..ltd"],
    ["a scheme", "https://evil.example/orgs"],
    ["an encoded slash", "zenosyne%2fltd"],
    ["a query string", "zenosyne-ltd?admin=1"],
    ["whitespace inside", "zenosyne ltd"],
    ["a leading separator", "-zenosyne"],
  ])("rejects an override with %s, without calling Forge", async (_why, value) => {
    const forge = fakeFetch({ body: fixture("orgs-single") });

    await expect(resolverFor(forge.fetchImpl, value).slug()).rejects.toThrow(
      ForgeError,
    );
    expect(forge.calls).toHaveLength(0);
  });

  it("does not echo the rejected override back into the error message", async () => {
    const secretish = "shouldnotappear/here";
    const forge = fakeFetch({ body: fixture("orgs-single") });

    const failure = await resolverFor(forge.fetchImpl, secretish)
      .slug()
      .catch((error: unknown) => error);

    expect((failure as ForgeError).message).not.toContain("shouldnotappear");
  });
});

describe("OrganizationResolver — one discovery per process", () => {
  it("calls GET /orgs once across many sequential resolutions", async () => {
    const forge = fakeFetch({ body: fixture("orgs-single") });
    const resolver = resolverFor(forge.fetchImpl);

    expect(await resolver.slug()).toBe("zenosyne-ltd");
    expect(await resolver.slug()).toBe("zenosyne-ltd");
    expect(await resolver.slug()).toBe("zenosyne-ltd");

    expect(forge.calls).toHaveLength(1);
  });

  it("shares one in-flight request across concurrent resolutions", async () => {
    const forge = fakeFetch({ body: fixture("orgs-single") });
    const resolver = resolverFor(forge.fetchImpl);

    const slugs = await Promise.all([
      resolver.slug(),
      resolver.slug(),
      resolver.slug(),
      resolver.slug(),
      resolver.slug(),
    ]);

    expect(slugs).toEqual(Array(5).fill("zenosyne-ltd"));
    expect(forge.calls).toHaveLength(1);
  });

  it("does not re-ask after a settled verdict about the organizations", async () => {
    const forge = fakeFetch({ body: fixture("orgs-multiple") });
    const resolver = resolverFor(forge.fetchImpl);

    await expect(resolver.slug()).rejects.toThrow(ForgeError);
    await expect(resolver.slug()).rejects.toThrow(ForgeError);

    expect(forge.calls).toHaveLength(1);
  });

  it("allows a retry after a transport failure, which settles nothing", async () => {
    const forge = fakeFetch((_call, index) =>
      index === 0
        ? new Error("connect ECONNREFUSED forge.laravel.com:443")
        : { body: fixture("orgs-single") },
    );
    const resolver = resolverFor(forge.fetchImpl);

    await expect(resolver.slug()).rejects.toThrow();
    await expect(resolver.slug()).resolves.toBe("zenosyne-ltd");
    expect(forge.calls).toHaveLength(2);
  });
});

describe("OrganizationResolver — laziness under a Forge outage", () => {
  it("constructs client and resolver with no request attempted", () => {
    const forge = unreachableFetch();

    // This is the wiring the MCP handshake performs. If it threw or awaited a
    // request, an outage would stop `initialize` from ever completing.
    expect(() => {
      const client = new ForgeClient({ token: TOKEN, fetchImpl: forge.fetchImpl });
      return new OrganizationResolver(client, process.env["NOT_SET_FORGE_ORG"]);
    }).not.toThrow();

    expect(forge.calls).toHaveLength(0);
  });

  it("surfaces the outage only when a tool actually resolves the slug", async () => {
    const forge = unreachableFetch();
    const resolver = resolverFor(forge.fetchImpl);

    expect(forge.calls).toHaveLength(0);
    await expect(resolver.slug()).rejects.toThrow();
    expect(forge.calls).toHaveLength(1);
  });
});

describe("OrganizationResolver — the token never leaks", () => {
  it("keeps the token out of a rejected-credential message", async () => {
    const forge = fakeFetch({
      status: 401,
      body: { message: "Unauthenticated." },
    });

    const failure = await resolverFor(forge.fetchImpl)
      .slug()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ForgeError);
    expect((failure as ForgeError).message).not.toContain(TOKEN);
  });

  it("keeps the token out of the multiple-organizations message", async () => {
    const forge = fakeFetch({ body: fixture("orgs-multiple") });

    const failure = await resolverFor(forge.fetchImpl)
      .slug()
      .catch((error: unknown) => error);

    expect((failure as ForgeError).message).not.toContain(TOKEN);
  });
});
