import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { ForgeClient } from "../src/client.js";
import {
  clientWriteLedgerInstalled,
  installClientWriteLedger,
} from "./support/client-ledger.js";
import {
  ALLOWED_METHOD,
  WriteAttemptError,
  attemptedCalls,
  fakeFetch,
  fixture,
  resetCallLedger,
  servedCalls,
} from "./support/fake-fetch.js";
import {
  UNREADABLE_METHOD,
  resolveRequestMethod,
} from "./support/http-method.js";
import {
  ENTITLED_REAL_FETCH_CALLER,
  NetworkAccessError,
  claimRealFetch,
  networkGuardInstalled,
} from "./support/network-guard.js";
import { ReadOnlyViolation, readOnlyTransport } from "./support/read-only.js";

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
   * The method that is not a string, which the platform accepts and this used to miss.
   *
   * `fetch` applies ToString to `init.method`, so `{ method: new String("POST") }` and
   * `{ method: { toString: () => "DELETE" } }` both send a write. A guard that tested
   * `typeof method === "string"` saw neither, resolved GET, and then the fake SERVED
   * the write and recorded it as a read — and `readOnlyTransport` handed it to the
   * socket. Nobody types `new String("POST")` on purpose; a method that came back from
   * a helper or a config object can be one without its author noticing.
   */
  it("coerces a method that is not a string, the way fetch itself would", () => {
    const target = "https://forge.laravel.com/api/orgs";
    const boxed = new String("POST") as unknown as string;
    const stringly = { toString: () => "DELETE" } as unknown as string;

    expect(resolveRequestMethod(target, { method: boxed })).toBe("POST");
    expect(resolveRequestMethod(target, { method: stringly })).toBe("DELETE");
    expect(resolveRequestMethod(target, { method: "patch" })).toBe("PATCH");
    // An `init` that carries no method at all still falls through to the Request.
    expect(
      resolveRequestMethod(new Request(target, { method: "POST" }), {}),
    ).toBe("POST");
  });

  it("calls a method it cannot read anything but a GET", () => {
    const target = "https://forge.laravel.com/api/orgs";
    // The platform would throw on this too. What matters is that the guard's answer to
    // "I cannot tell what this is" is never GET.
    const throwing = {
      toString() {
        throw new Error("no method for you");
      },
    } as unknown as string;

    expect(resolveRequestMethod(target, { method: throwing })).toBe(
      UNREADABLE_METHOD,
    );
    expect(UNREADABLE_METHOD).not.toBe("GET");
    expect(
      resolveRequestMethod(target, {
        method: Symbol("POST") as unknown as string,
      }),
    ).not.toBe("GET");
  });

  it("refuses a non-string method at the fake seam and in the read-only transport", async () => {
    const boxed = new String("POST") as unknown as string;
    const forge = fakeFetch({ body: {} });

    await expect(
      forge.fetchImpl("https://forge.laravel.com/api/orgs/z/servers/1/deploy", {
        method: boxed,
      }),
    ).rejects.toBeInstanceOf(WriteAttemptError);
    expect(servedCalls()).toEqual([]);
    expect(attemptedCalls().map((call) => call.method)).toEqual(["POST"]);

    // The same value against the transport that wraps the REAL fetch on the smoke
    // test's runs. The underlying is a stub here: nothing in this file may reach a
    // socket, and the assertion is that the transport refuses before it would.
    const answered: string[] = [];
    const underlying = (async (input: unknown) => {
      answered.push(String(input));
      return new Response("{}");
    }) as unknown as typeof fetch;
    const transport = readOnlyTransport(underlying);

    await expect(
      transport("https://forge.laravel.com/api/orgs/z/servers/1/deploy", {
        method: boxed,
      }),
    ).rejects.toBeInstanceOf(ReadOnlyViolation);
    expect(answered).toEqual([]);
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
 * The two seams are re-asserted symmetrically, and this is the half that was missing.
 *
 * `globalThis.fetch` is checked after every test by `networkGuardInstalled()`, because
 * a test that replaced it would leave the rest of its file unguarded. The wrapper on
 * `ForgeClient.prototype.request` — the second write lock — had no such check, so it
 * could be replaced with nothing noticing. The replacement does not have to be an
 * evasion: `vi.spyOn(ForgeClient.prototype, "request")` is a thing a contributor writes
 * to count calls, and it removes the ledger for every test after it in that file.
 */
describe("the client write ledger is checked as the fetch guard is", () => {
  it("is installed for every test, not merely for this one", () => {
    expect(clientWriteLedgerInstalled()).toBe(true);
  });

  it("notices when something replaces ForgeClient.prototype.request", () => {
    const original = ForgeClient.prototype.request;
    try {
      ForgeClient.prototype.request = (async () =>
        ({})) as typeof ForgeClient.prototype.request;

      expect(clientWriteLedgerInstalled()).toBe(false);
    } finally {
      ForgeClient.prototype.request = original;
    }

    // Restored, so the after-each assertion this test is about does not fail on it.
    expect(clientWriteLedgerInstalled()).toBe(true);
  });

  it("re-installs over a replacement instead of wrapping itself twice", async () => {
    // Called again while it is already in place: a second wrapper would record every
    // request through the client twice, and the ledger would report writes nobody made.
    installClientWriteLedger();
    installClientWriteLedger();

    const forge = fakeFetch({ body: { data: [] } });
    const client = new ForgeClient({ token: TOKEN, fetchImpl: forge.fetchImpl });
    await client.request("GET", "/orgs");

    expect(servedCalls().filter((call) => call.url === "/orgs")).toHaveLength(1);
    expect(clientWriteLedgerInstalled()).toBe(true);
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
  /**
   * Files the scan reads as text and cannot: an image or an archive is bytes, and
   * `readFileSync(…, "utf8")` on one yields mojibake that no pattern here means
   * anything against. Nothing under `test/` matches today; the list exists so that
   * adding a screenshot to a fixture directory does not break the scan, and it is
   * stated in test/README.md so the exclusion is visible rather than discovered.
   */
  const UNREADABLE_EXTENSIONS = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".pdf",
    ".zip",
    ".gz",
    ".woff",
    ".woff2",
  ];

  /**
   * Every file under a directory, at any depth, whatever its extension.
   *
   * Both halves of that were wrong before. Fixtures were listed non-recursively, so a
   * token in `test/fixtures/sub/x.json` was never read; and only `.ts`, `.md` and
   * `.json` were opened, so a token in `test/notes.txt` was never read either. Neither
   * is a clever hiding place — a subdirectory is what a second batch of recordings gets
   * put in, and `.txt` is what a scratch capture is saved as.
   */
  function filesUnder(dir: string): { name: string; text: string }[] {
    return readdirSync(dir, { recursive: true })
      .filter((entry): entry is string => typeof entry === "string")
      .filter((name) => statSync(join(dir, name)).isFile())
      .filter(
        (name) =>
          !UNREADABLE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)),
      )
      .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
  }

  /** Everything committed under `test/` — fixtures, sources, this file, the README. */
  const scanned = filesUnder(TEST_DIR);

  const fixtures = scanned.filter(
    (file) => file.name.startsWith("fixtures/") && file.name.endsWith(".json"),
  );
  const testSources = scanned.filter(
    (file) => !file.name.startsWith("fixtures/"),
  );

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
   * A secret carried in a URL query string — the shape these fixtures already have.
   *
   * `sites-page-1.json` records `deployment_url`, and a real one ends with a
   * `deploy/http` path and a token query parameter: an UNAUTHENTICATED write trigger. Anyone holding
   * that URL can deploy the site, with no API token and no account. It is exactly the
   * value that must never be committed, and it was invisible to every rule above — the
   * opaque-run scan starts at forty characters, and a real deploy token is shorter than
   * that.
   *
   * So the rule is not about length: a query parameter NAMED like a secret must carry a
   * value that is a declared placeholder. `?token=deploytoken` passes because a row
   * below says what it is; a thirty-two character real one fails on sight.
   */
  const QUERY_SECRET =
    /[?&](?:token|api[_-]?key|api[_-]?token|access[_-]?token|auth|key|secret|signature|sig)=([^&"'`\s\\]+)/gi;

  /**
   * The placeholders a query secret may be, each obviously not a credential.
   *
   * Held to a shape by the check below — short, lowercase, wordlike — so that a row
   * cannot be a real token somebody decided to keep, and so that reviewing a new row is
   * reviewing a word rather than reviewing a length.
   */
  const ALLOWED_QUERY_SECRETS: { value: string; why: string }[] = [
    {
      value: "deploytoken",
      why: "The deploy-trigger placeholder in sites-page-1.json. `deployment_url` is recorded so the site tools can be shown never to copy it into a tool result; the value itself is a word, not a token.",
    },
    {
      value: "deploytoken2",
      why: "The same placeholder for the second site in sites-page-1.json, distinct only so a test can tell the two recordings apart.",
    },
  ];

  /** What a placeholder row may look like: a short lowercase word, and a reason. */
  const QUERY_PLACEHOLDER_SHAPE = /^[a-z][a-z0-9_-]{2,19}$/;

  function queryPlaceholderRowIsWellFormed(row: {
    value: string;
    why: string;
  }): boolean {
    return (
      QUERY_PLACEHOLDER_SHAPE.test(row.value) && row.why.trim().length >= 30
    );
  }

  /** Every query-carried secret in `text` that is not a declared placeholder. */
  function querySecretsIn(text: string): string[] {
    const allowed = new Set(ALLOWED_QUERY_SECRETS.map((row) => row.value));
    return [...text.matchAll(QUERY_SECRET)]
      .map((match) => match[1] as string)
      .filter((value) => !allowed.has(value));
  }

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

  it.each(scanned.map((f) => [f.name, f] as const))(
    "%s carries no secret in a query string",
    (_name, file) => {
      expect(
        querySecretsIn(file.text),
        `${file.name} carries a query parameter that names a secret and whose value is not a declared placeholder. A Forge deploy_url token is an unauthenticated write trigger: anyone holding the URL can deploy the site. Replace it with a placeholder and add the row to ALLOWED_QUERY_SECRETS.`,
      ).toEqual([]);
    },
  );

  it("catches the deploy trigger a real recording would carry", () => {
    // A real `deployment_url`, with a value the length one actually has — well under
    // the forty characters the opaque-run scan starts at, which is why that scan never
    // saw this and why this rule reads the parameter NAME instead.
    // Assembled from parts: written as a literal, this file would itself carry a
    // query-borne secret and the scan above — which reads this file — would be right
    // to fail on it.
    const value = "a1b2c3d4".repeat(4);
    const real = `"deployment_url": "https://forge.laravel.com/x/deploy/http?${"token"}=${value}"`;

    expect(querySecretsIn(real)).toEqual([value]);
    expect(opaqueRunsIn(real)).toEqual([]); // The rule this one exists to cover for.
  });

  it("lets the declared placeholders through, and only those", () => {
    expect(
      querySecretsIn("https://forge.laravel.com/x/deploy/http?token=deploytoken"),
    ).toEqual([]);
    expect(
      querySecretsIn(`https://forge.laravel.com/x?${"api_key"}=notaplaceholder`),
    ).toEqual(["notaplaceholder"]);
    expect(querySecretsIn("https://forge.laravel.com/x?page=2")).toEqual([]);
  });

  it("holds every query placeholder to a shape a real token cannot have", () => {
    const REASON =
      "a reason long enough to be an actual reason rather than a placeholder";

    expect(
      queryPlaceholderRowIsWellFormed({ value: "a1b2c3d4".repeat(4), why: REASON }),
    ).toBe(false);
    expect(queryPlaceholderRowIsWellFormed({ value: "x", why: REASON })).toBe(
      false,
    );
    expect(
      queryPlaceholderRowIsWellFormed({ value: "deploytoken", why: "because" }),
    ).toBe(false);

    for (const row of ALLOWED_QUERY_SECRETS) {
      expect(
        queryPlaceholderRowIsWellFormed(row),
        `ALLOWED_QUERY_SECRETS row "${row.value}" is not a short, obviously-fake word with a stated reason.`,
      ).toBe(true);
      expect(
        scanned.some((file) => file.text.includes(row.value)),
        `ALLOWED_QUERY_SECRETS still exempts "${row.value}", which nothing under test/ contains any more. Delete the row.`,
      ).toBe(true);
    }
  });

  /**
   * The enumeration itself, which is where the two silent gaps were.
   *
   * A token in `test/fixtures/sub/x.json` was never read, because fixtures were listed
   * with a non-recursive `readdirSync`. A token in `test/notes.txt` was never read,
   * because only `.ts`, `.md` and `.json` were opened. Both are ordinary places for a
   * recording or a scratch capture to end up, so both are read now — and this test
   * plants a token in each and requires the scan to come back with them.
   */
  it("reads every file under test/, at any depth and whatever the extension", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-credential-scan-"));
    try {
      mkdirSync(join(root, "sub"));
      writeFileSync(
        join(root, "sub", "x.json"),
        `{ "captured": "${"A1b2C3d4".repeat(6)}" }`,
      );
      writeFileSync(join(root, "notes.txt"), `token ${"Z9y8X7w6".repeat(6)}`);
      writeFileSync(join(root, "screenshot.png"), "not really an image");

      const found = filesUnder(root);

      expect(found.map((file) => file.name).sort()).toEqual([
        "notes.txt",
        join("sub", "x.json"),
      ]);
      expect(found.flatMap((file) => opaqueRunsIn(file.text))).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("really is reading the whole tree on this run, not only the top level", () => {
    const names = scanned.map((file) => file.name);

    expect(names).toContain("harness.test.ts");
    expect(names).toContain("README.md");
    expect(names).toContain(join("support", "fake-fetch.ts"));
    expect(names).toContain(join("fixtures", "sites-page-1.json"));
    // A file that is neither .ts, .md nor .json, which the old scan skipped by rule.
    expect(names).toContain(join("tsconfig.json"));
    expect(fixtures.length).toBeGreaterThan(0);
  });

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
