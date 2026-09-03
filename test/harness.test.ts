import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { ForgeClient } from "../src/client.js";
import {
  ALLOWED_METHOD,
  WriteAttemptError,
  attemptedCalls,
  fakeFetch,
  fixture,
  resetCallLedger,
  servedCalls,
} from "./support/fake-fetch.js";
import { resolveRequestMethod } from "./support/http-method.js";
import {
  ENTITLED_REAL_FETCH_CALLER,
  NetworkAccessError,
  claimRealFetch,
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

/**
 * Where the probes below aim.
 *
 * A closed port on loopback, deliberately: if the guard were ever missing, a probe
 * must fail against this machine rather than open a connection to somebody's account.
 * The assertion is on the KIND of failure — the guard's refusal, not a refused
 * connection — so an unguarded run is a red test either way.
 */
const UNROUTABLE = "http://127.0.0.1:1/";

async function probeGuard(target = UNROUTABLE): Promise<string> {
  try {
    await globalThis.fetch(target);
    return "answered";
  } catch (error) {
    return error instanceof NetworkAccessError
      ? "refused"
      : `escaped the guard: ${String(error)}`;
  }
}

/**
 * Three probes fired before any `beforeEach` can run.
 *
 * The guard used to be installed in `beforeEach`, which left everything that runs
 * earlier — a test file's module scope and its `beforeAll` hooks — talking to the real
 * `fetch`. That is not a narrow window: `ForgeClient` captures `globalThis.fetch` when
 * it is CONSTRUCTED, so a client built in either place kept the real one and went on
 * using it from inside ordinary tests, which is where the leak would finally happen
 * and the last place anyone would look for its cause.
 *
 * These run at module scope and in `beforeAll` respectively and are asserted inside
 * tests, so the file records what the guard did before the file's tests existed.
 */
const atModuleScope = probeGuard();
const clientBuiltAtModuleScope = new ForgeClient({
  token: TOKEN,
  baseUrl: "http://127.0.0.1:1",
});
let atBeforeAll = "<beforeAll did not run>";
let clientBuiltInBeforeAll: ForgeClient | null = null;

beforeAll(async () => {
  atBeforeAll = await probeGuard();
  clientBuiltInBeforeAll = new ForgeClient({
    token: TOKEN,
    baseUrl: "http://127.0.0.1:1",
  });
});

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

  it("was already armed at module scope, before any hook ran", async () => {
    await expect(atModuleScope).resolves.toBe("refused");
  });

  it("was already armed in beforeAll", () => {
    expect(atBeforeAll).toBe("refused");
  });

  it("catches a client built at module scope, which captured fetch at that moment", async () => {
    await expect(
      clientBuiltAtModuleScope.request("GET", "/orgs"),
    ).rejects.toBeInstanceOf(NetworkAccessError);
  });

  it("catches a client built in beforeAll for the same reason", async () => {
    expect(clientBuiltInBeforeAll).not.toBeNull();
    await expect(
      clientBuiltInBeforeAll?.request("GET", "/orgs"),
    ).rejects.toBeInstanceOf(NetworkAccessError);
  });

  it("names the method a Request carries, rather than calling it a GET", async () => {
    const error = await globalThis
      .fetch(new Request(UNROUTABLE, { method: "POST" }))
      .then(
        () => undefined,
        (e: unknown) => e as Error,
      );

    expect(error).toBeInstanceOf(NetworkAccessError);
    expect(error?.message).toContain("POST");
  });
});

/**
 * The real `fetch` is not a shared handle.
 *
 * It was exported as a constant, which made "only the integration smoke test may use
 * it" a comment rather than a rule: any file could import it, and nothing recorded
 * that anything had. `claimRealFetch()` refuses a caller that is not the entitled
 * file, so the entitlement is checked at the reach.
 */
describe("only the integration smoke test can obtain the real fetch", () => {
  it("refuses a claim from this file", () => {
    expect(() => claimRealFetch()).toThrow(NetworkAccessError);
  });

  it("says which file is entitled and what to use instead", () => {
    try {
      claimRealFetch();
      expect.unreachable("claimRealFetch() returned to an unentitled caller");
    } catch (error) {
      expect((error as Error).message).toContain(ENTITLED_REAL_FETCH_CALLER);
      expect((error as Error).message).toContain("fakeFetch()");
    }
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

  /**
   * The shape that used to get through everywhere: the method on the `Request`.
   *
   * `init?.method ?? "GET"` reads nothing at all from `fetch(new Request(url, { method:
   * "POST" }))`, so the fake served the write and recorded it as a read — the ledger
   * the after-each check reads would have said GET. One shared resolver now answers
   * the question for the fake, the read-only transport and the network guard alike.
   */
  it("refuses a method carried on a Request object, not merely one passed in init", async () => {
    const forge = fakeFetch({ body: {} });

    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      await expect(
        forge.fetchImpl(
          new Request("https://forge.laravel.com/api/orgs/z/servers/1", {
            method,
          }),
        ),
      ).rejects.toBeInstanceOf(WriteAttemptError);
    }

    expect(servedCalls()).toEqual([]);
    expect(attemptedCalls().map((call) => call.method)).toEqual([
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "POST",
    ]);
  });

  it("records what a Request actually was, so the ledger cannot report a POST as a GET", async () => {
    const forge = fakeFetch({ body: {} });
    await forge
      .fetchImpl(new Request("https://forge.laravel.com/api/x", { method: "POST" }))
      .catch(() => undefined);

    expect(forge.calls).toEqual([
      { url: "https://forge.laravel.com/api/x", method: "POST" },
    ]);
  });

  it("resolves the method the way fetch itself does", () => {
    const target = "https://forge.laravel.com/api/orgs";

    expect(resolveRequestMethod(target)).toBe("GET");
    expect(resolveRequestMethod(target, { method: "post" })).toBe("POST");
    expect(resolveRequestMethod(new Request(target, { method: "POST" }))).toBe(
      "POST",
    );
    // An explicit init wins over the Request, in both directions — that is the
    // precedence the platform has, and a guard that disagrees with it guards a
    // different request from the one being sent.
    expect(
      resolveRequestMethod(new Request(target, { method: "POST" }), {
        method: "GET",
      }),
    ).toBe("GET");
    expect(
      resolveRequestMethod(new Request(target), { method: "DELETE" }),
    ).toBe("DELETE");
  });

  /**
   * The second lock, and what makes it independent.
   *
   * It used to read `fakeFetch`'s ledger and nothing else, so a suite that handed
   * `ForgeClient` a fetch it wrote by hand — a pattern that already exists in
   * `test/org.test.ts`, legitimately, to inspect the abort signal — could have a write
   * ANSWERED with the after-each check none the wiser. Every request through the
   * client is now reported, whatever fetch is behind it.
   */
  it("catches a write served by a hand-rolled fetchImpl the fake's ledger never sees", async () => {
    const handRolled = (async () =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const client = new ForgeClient({ token: TOKEN, fetchImpl: handRolled });

    // Answered, because nothing in that stub refuses anything. That is the point.
    await expect(
      client.request("POST", "/orgs/z/servers/1/sites/2/deployments"),
    ).resolves.toBeDefined();

    expect(
      servedCalls()
        .filter((call) => call.method !== "GET")
        .map((call) => `${call.method} ${call.url}`),
    ).toEqual(["POST /orgs/z/servers/1/sites/2/deployments"]);

    // The after-each check reads this same ledger and would now fail THIS test, which
    // is exactly the proof wanted. Clearing it here — the one place in the suite that
    // does — keeps the demonstration from failing the demonstration.
    resetCallLedger();
  });

  it("still lets a hand-rolled fetchImpl serve a GET, which several suites rely on", async () => {
    const handRolled = (async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const client = new ForgeClient({ token: TOKEN, fetchImpl: handRolled });

    await expect(client.request("GET", "/orgs")).resolves.toEqual({ data: [] });
    expect(servedCalls().map((call) => call.method)).toEqual(["GET"]);
  });

  it("reports a refused write as attempted and never as served, through any fetch", async () => {
    const refusing = (async () => {
      throw new Error("this stub answers nothing");
    }) as unknown as typeof fetch;
    const client = new ForgeClient({ token: TOKEN, fetchImpl: refusing });

    await expect(client.request("POST", "/orgs/z/deployments")).rejects.toThrow();

    expect(attemptedCalls().map((call) => call.method)).toContain("POST");
    expect(servedCalls()).toEqual([]);
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
   * digits.
   *
   * Applied to fixtures AND to test sources. It was fixtures only, on the reasoning
   * that source holds long identifiers — but nothing under `test/` contains a
   * forty-character unbroken alphanumeric run except the one declared decoy, and a
   * token pasted into a `.ts` file while debugging against a live account is at least
   * as likely as one recorded into JSON. Committed is committed either way.
   */
  const OPAQUE_TOKEN = /\b[A-Za-z0-9]{40,}\b/g;

  /** What a single allowlist row must itself look like. See the check below. */
  const OPAQUE_TOKEN_SHAPE = /^[A-Za-z0-9]{40,}$/;

  /** The scan, as one function, so the tests below exercise the thing that runs. */
  function opaqueRunsIn(text: string): string[] {
    const stripped = ALLOWED_LOOKALIKES.reduce(
      (carried, allowed) => carried.split(allowed.value).join("<allowed>"),
      text,
    );
    return stripped.match(OPAQUE_TOKEN) ?? [];
  }

  /**
   * Whether an allowlist row is a row at all.
   *
   * Stripping is substring replacement, so a SHORT value does not exempt one string —
   * it dissolves every string. A row of `{ value: "0" }` removes every zero anywhere
   * in the scanned text, which breaks a real forty-character token into fragments too
   * short to match, and the scan goes on reporting nothing for evermore. It would even
   * satisfy the "earning its row" check below, because some fixture certainly contains
   * a zero.
   *
   * So a row must be exactly what it claims to be: one whole string of the shape the
   * scan looks for, with a reason long enough to be a reason.
   */
  function allowlistRowIsWellFormed(row: { value: string; why: string }): boolean {
    return OPAQUE_TOKEN_SHAPE.test(row.value) && row.why.trim().length >= 30;
  }

  /**
   * Long opaque strings that are deliberately in a fixture, each with the reason.
   *
   * An allowlist is the honest way to run a shape-based scan: the alternative is a
   * pattern loose enough to miss a real token. Adding a row is a reviewable decision,
   * a row must be well-formed by the rule above, and a row that no longer matches
   * anything fails — so the list can neither widen the scan by accident nor outlive
   * the fixture that needed it.
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

  /** Fixtures and sources alike: a committed token does not care which it is in. */
  const scannedForOpaqueStrings = [...fixtures, ...testSources];

  it.each(scannedForOpaqueStrings.map((f) => [f.name, f] as const))(
    "%s carries no long opaque string that is not a declared decoy",
    (_name, file) => {
      expect(
        opaqueRunsIn(file.text),
        `${file.name} contains a long opaque string that looks like a Forge API token. If it is genuinely test data, add it to ALLOWED_LOOKALIKES with the reason; if it is a credential, it must never be committed.`,
      ).toEqual([]);
    },
  );

  it("scans test sources for that shape too, not fixtures alone", () => {
    const names = scannedForOpaqueStrings.map((file) => file.name);

    expect(names).toContain("harness.test.ts");
    expect(names.some((name) => name.endsWith("support/fake-fetch.ts"))).toBe(
      true,
    );
    expect(names.some((name) => name.endsWith(".json"))).toBe(true);
  });

  it("catches a token pasted into a .ts file, which is where one is pasted", () => {
    // Assembled at run time: written as a literal it would be a token in a `.ts` file,
    // and the scan above — which now reads this file — would be right to fail on it.
    const planted = `const captured = "${"A1b2C3d4".repeat(6)}";`;

    expect(opaqueRunsIn(planted)).toHaveLength(1);
  });

  it("refuses an allowlist row that would neuter the scan instead of narrowing it", () => {
    const REASON =
      "a reason long enough to be an actual reason rather than a placeholder";
    const wellFormed = "B".repeat(44);

    expect(allowlistRowIsWellFormed({ value: "0", why: REASON })).toBe(false);
    expect(allowlistRowIsWellFormed({ value: "", why: REASON })).toBe(false);
    expect(allowlistRowIsWellFormed({ value: "B".repeat(39), why: REASON })).toBe(
      false,
    );
    expect(
      allowlistRowIsWellFormed({ value: `${wellFormed} and more`, why: REASON }),
    ).toBe(false);
    expect(allowlistRowIsWellFormed({ value: wellFormed, why: "because" })).toBe(
      false,
    );
    expect(allowlistRowIsWellFormed({ value: wellFormed, why: REASON })).toBe(
      true,
    );

    // And the row that neuters the scan really does neuter it, which is why the shape
    // is enforced rather than trusted: with `{ value: "0" }` allowed, a planted token
    // carrying a zero comes back clean.
    const planted = `token=${"A1b2C3d0".repeat(6)}`;
    const dissolved = planted.split("0").join("<allowed>");
    expect(planted.match(OPAQUE_TOKEN) ?? []).toHaveLength(1);
    expect(dissolved.match(OPAQUE_TOKEN) ?? []).toEqual([]);
  });

  it("holds every allowlisted row to that shape", () => {
    for (const allowed of ALLOWED_LOOKALIKES) {
      expect(
        allowlistRowIsWellFormed(allowed),
        `ALLOWED_LOOKALIKES row "${allowed.value}" is not one whole opaque string with a stated reason. A short value does not exempt one string, it dissolves every string: it strips that substring everywhere and the scan stops being able to see a token at all.`,
      ).toBe(true);
    }
  });

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
