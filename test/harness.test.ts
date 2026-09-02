import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ForgeClient } from "../src/client.js";
import {
  ALLOWED_METHOD,
  WriteAttemptError,
  attemptedCalls,
  fakeFetch,
  fixture,
  servedCalls,
} from "./support/fake-fetch.js";
import {
  NetworkAccessError,
  networkGuardInstalled,
} from "./support/network-guard.js";

/**
 * The harness testing itself.
 *
 * Every other suite in this directory rests on three assumptions: that no test can
 * reach the real Forge API, that no test can issue a write, and that no fixture
 * carries a credential. Assumptions in a comment are assumptions that decay, so each
 * one is asserted here against the mechanism that enforces it — including by doing
 * the forbidden thing and requiring it to fail.
 */

const TOKEN = "test-token";
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));
const TEST_DIR = fileURLToPath(new URL("./", import.meta.url));

describe("the default suite cannot reach the network", () => {
  it("has the guard installed for every test, not merely for this one", () => {
    expect(networkGuardInstalled()).toBe(true);
  });

  it("refuses a direct call to the real Forge API", async () => {
    await expect(
      globalThis.fetch("https://forge.laravel.com/api/orgs"),
    ).rejects.toBeInstanceOf(NetworkAccessError);
  });

  it("names the offending test, the method and the target in the refusal", async () => {
    const error = await globalThis
      .fetch("https://forge.laravel.com/api/orgs/x/servers", { method: "GET" })
      .then(
        () => undefined,
        (e: unknown) => e as Error,
      );

    expect(error?.message).toContain(
      "names the offending test, the method and the target in the refusal",
    );
    expect(error?.message).toContain("GET");
    expect(error?.message).toContain(
      "https://forge.laravel.com/api/orgs/x/servers",
    );
    expect(error?.message).toContain("fakeFetch()");
  });

  it("refuses any host, not only Forge", async () => {
    for (const target of [
      "http://127.0.0.1:9/",
      "https://example.com",
      "https://registry.npmjs.org/forge-mcp",
    ]) {
      await expect(globalThis.fetch(target)).rejects.toBeInstanceOf(
        NetworkAccessError,
      );
    }
  });

  it("catches the mistake that actually happens: a client built with no fetchImpl", async () => {
    // `ForgeClient` falls back to `globalThis.fetch`, so this is the exact shape of a
    // test that would otherwise run against a live account with a real token.
    const client = new ForgeClient({ token: TOKEN });

    await expect(client.request("GET", "/orgs")).rejects.toBeInstanceOf(
      NetworkAccessError,
    );
  });

  it("refuses a URL object and a Request as readily as a string", async () => {
    await expect(
      globalThis.fetch(new URL("https://forge.laravel.com/api/orgs")),
    ).rejects.toBeInstanceOf(NetworkAccessError);
    await expect(
      globalThis.fetch(new Request("https://forge.laravel.com/api/orgs")),
    ).rejects.toBeInstanceOf(NetworkAccessError);
  });
});

describe("no test performs a write of any kind", () => {
  it("refuses a non-GET at the fake seam", async () => {
    const forge = fakeFetch({ body: {} });

    await expect(
      forge.fetchImpl("https://forge.laravel.com/api/orgs/z/servers/1/deploy", {
        method: "POST",
      }),
    ).rejects.toBeInstanceOf(WriteAttemptError);
  });

  it("refuses PUT and DELETE the same way", async () => {
    const forge = fakeFetch({ body: {} });

    for (const method of ["PUT", "DELETE", "PATCH"]) {
      await expect(
        forge.fetchImpl("https://forge.laravel.com/api/orgs/z/servers/1", {
          method,
        }),
      ).rejects.toBeInstanceOf(WriteAttemptError);
    }
  });

  it("refuses a write issued through ForgeClient, which is how a real one would arrive", async () => {
    const forge = fakeFetch({ body: {} });
    const client = new ForgeClient({ token: TOKEN, fetchImpl: forge.fetchImpl });

    await expect(
      client.request("POST", "/orgs/z/servers/1/sites/2/deploy"),
    ).rejects.toBeInstanceOf(WriteAttemptError);
  });

  it("records the refused attempt but serves nothing, which is what the after-each check reads", async () => {
    const forge = fakeFetch({ body: {} });
    await forge
      .fetchImpl("https://forge.laravel.com/api/x", { method: "POST" })
      .catch(() => undefined);

    expect(attemptedCalls().map((call) => call.method)).toContain("POST");
    expect(servedCalls().map((call) => call.method)).not.toContain("POST");
  });

  it("serves a GET, so the refusal is about the method and not about everything", async () => {
    const forge = fakeFetch({ body: { data: [] } });
    const response = await forge.fetchImpl("https://forge.laravel.com/api/x");

    expect(response.ok).toBe(true);
    expect(servedCalls().map((call) => call.method)).toEqual([ALLOWED_METHOD]);
  });

  it("leaves GET as the single method the whole suite is allowed to serve", () => {
    expect(ALLOWED_METHOD).toBe("GET");
  });
});

/**
 * Fixtures are recorded API payloads, and a recording is exactly the artefact a real
 * credential slips into: the account it was captured from had one, and a header, a
 * query string or a reflected error body carries it into the JSON without anybody
 * choosing to put it there.
 *
 * So the scan is not "does anyone remember to check" — it runs on every fixture on
 * every test run. Patterns are shape-based rather than value-based, because the value
 * this must catch is by definition one nobody has seen yet.
 */
describe("no fixture carries a credential", () => {
  const fixtures = readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, text: readFileSync(FIXTURE_DIR + name, "utf8") }));

  const testSources = readdirSync(TEST_DIR, { recursive: true })
    .filter((name): name is string => typeof name === "string")
    .filter((name) => name.endsWith(".ts") || name.endsWith(".md"))
    .map((name) => ({ name, text: readFileSync(TEST_DIR + name, "utf8") }));

  /**
   * Credential shapes that are never acceptable anywhere under `test/`.
   *
   * Each is a prefix or structure a scanner can recognise without knowing the secret.
   */
  const CREDENTIAL_SHAPES: { name: string; pattern: RegExp }[] = [
    {
      name: "PEM private key block",
      pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    },
    { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
    {
      name: "GitHub fine-grained PAT",
      pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    },
    { name: "OpenAI-style secret key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
    {
      name: "Stripe secret key",
      pattern: /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/,
    },
    { name: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
    {
      name: "JSON Web Token",
      pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
    },
  ];

  /**
   * The shape a Forge API token actually has: a long opaque run of letters and
   * digits. Applied to fixtures only — recorded JSON has no legitimate reason to
   * carry one, while test SOURCE holds long identifiers and Unicode tables that would
   * make this noise rather than signal.
   */
  const OPAQUE_TOKEN = /\b[A-Za-z0-9]{40,}\b/g;

  /**
   * Long opaque strings that are deliberately in a fixture, each with the reason.
   *
   * An allowlist is the honest way to run a shape-based scan: the alternative is a
   * pattern loose enough to miss a real token. Adding a row is a reviewable decision,
   * and the last test in this block deletes the possibility of a row that no longer
   * matches anything and is quietly widening the scan.
   */
  const ALLOWED_LOOKALIKES: { value: string; why: string }[] = [
    {
      value: "AAAAB3NzaC1yc2EAAAADAQABexamplekeymaterial",
      why: "SSH PUBLIC key material in the server fixtures. A public key is not a credential, and it is recorded precisely so the tools can be shown never to copy `local_public_key` into a tool result.",
    },
  ];

  it.each(fixtures.map((f) => [f.name, f] as const))(
    "%s carries no recognisable credential",
    (_name, file) => {
      for (const shape of CREDENTIAL_SHAPES) {
        expect(
          shape.pattern.test(file.text),
          `${file.name} contains something shaped like a ${shape.name}. Fixtures are committed: replace it with obviously fake data.`,
        ).toBe(false);
      }
    },
  );

  it.each(fixtures.map((f) => [f.name, f] as const))(
    "%s carries no long opaque string that is not a declared decoy",
    (_name, file) => {
      const stripped = ALLOWED_LOOKALIKES.reduce(
        (text, allowed) => text.split(allowed.value).join("<allowed>"),
        file.text,
      );

      expect(
        stripped.match(OPAQUE_TOKEN) ?? [],
        `${file.name} contains a long opaque string that looks like a Forge API token. If it is genuinely test data, add it to ALLOWED_LOOKALIKES with the reason; if it is a credential, it must never be committed.`,
      ).toEqual([]);
    },
  );

  it.each(testSources.map((f) => [f.name, f] as const))(
    "test/%s carries no recognisable credential either",
    (_name, file) => {
      for (const shape of CREDENTIAL_SHAPES) {
        expect(
          shape.pattern.test(file.text),
          `test/${file.name} contains something shaped like a ${shape.name}.`,
        ).toBe(false);
      }
    },
  );

  /**
   * The one check that can see a REAL token: the machine running the suite may have a
   * working Forge credential in its environment, and if any committed file contains
   * it then it was captured from a live session and is already a disclosure.
   */
  it("contains nothing matching the credential in this machine's environment", () => {
    const live = process.env["FORGE_API_KEY"] ?? "";
    if (live.length < 8) return; // Unset, or too short to be a real token.

    for (const file of [...fixtures, ...testSources]) {
      expect(
        file.text.includes(live),
        `${file.name} contains the value of FORGE_API_KEY from this environment. It must be removed from the working tree and the credential rotated.`,
      ).toBe(false);
    }
  });

  it("uses the one obviously-fake token everywhere a suite needs one", () => {
    // Built from parts rather than written as a literal: a literal would appear in
    // this file's own source in a form that matches itself.
    const declaration = new RegExp('const\\s+TOKEN\\s*=\\s*"([^"]*)"', "g");

    for (const file of testSources.filter((f) => f.name.endsWith(".ts"))) {
      for (const match of file.text.matchAll(declaration)) {
        expect(
          match[1],
          `test/${file.name} declares a TOKEN other than the shared sentinel. Every suite uses "test-token" so that a real credential in this position is obvious on sight.`,
        ).toBe(TOKEN);
      }
    }
  });

  it("keeps every allowlisted lookalike earning its row", () => {
    for (const allowed of ALLOWED_LOOKALIKES) {
      expect(
        fixtures.some((file) => file.text.includes(allowed.value)),
        `ALLOWED_LOOKALIKES still exempts "${allowed.value}", which no fixture contains any more. Delete the row rather than leaving the scan wider than it needs to be.`,
      ).toBe(true);
    }
  });
});

/**
 * Fixtures are the recorded shape of a live API, and the code parses that shape. A
 * fixture that drifts — an envelope renamed, a `meta` block dropped — turns a suite
 * that looks like it tests the real payload into one that tests a payload Forge never
 * sends. These are the invariants every recording shares, checked once here rather
 * than assumed in each suite that loads one.
 */
describe("fixtures still have the shape the code parses", () => {
  const names = readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""));

  it("records at least the payloads stage 1 needs", () => {
    expect(names).toEqual(
      expect.arrayContaining([
        "orgs-single",
        "orgs-multiple",
        "server-single",
        "servers-page-1",
        "sites-page-1",
      ]),
    );
  });

  it.each(names)("%s parses and carries a `data` envelope", (name) => {
    const parsed = fixture<Record<string, unknown>>(name);

    expect(parsed).toBeTypeOf("object");
    expect(Object.keys(parsed)).toContain("data");
  });

  it.each(names.filter((name) => name.includes("page")))(
    "%s carries the cursor metadata the pager reads",
    (name) => {
      const parsed = fixture<{ data: unknown; meta?: Record<string, unknown> }>(
        name,
      );

      expect(Array.isArray(parsed.data)).toBe(true);
      expect(parsed.meta).toBeTypeOf("object");
      expect(Object.keys(parsed.meta ?? {})).toContain("next_cursor");
    },
  );

  it.each(names.filter((name) => name.startsWith("orgs-")))(
    "%s carries a list of organizations, as GET /orgs returns",
    (name) => {
      const parsed = fixture<{ data: unknown }>(name);

      expect(Array.isArray(parsed.data)).toBe(true);
    },
  );
});
