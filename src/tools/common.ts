import { z } from "zod";

import { ForgeError } from "../errors.js";

/**
 * The parts every read tool shares: argument validation, cursor pagination, and the
 * coercion that decides what upstream text is allowed to reach the agent.
 *
 * Everything a tool returns is read by a model that also holds `reboot_server` and
 * `update_deployment_script`, and a server name, a site domain or a git branch is
 * chosen by whoever owns the Forge account — so upstream strings are DATA that must
 * arrive in a fixed, bounded shape, never a structure Forge got to design. Two rules
 * follow, and both are enforced here rather than per tool:
 *
 * 1. Projection is a whitelist. A tool copies the fields it names, one at a time,
 *    each through a coercer. An attribute Forge adds later — `system_prompt`,
 *    `note`, anything — is dropped because nothing copies it, not because something
 *    filters it out.
 * 2. Every scalar is bounded. A name is a name, not the 40KB of prose a compromised
 *    account could put in one, replayed into context on every later call.
 */

/** How many items a list tool asks for when the caller says nothing. */
export const DEFAULT_PAGE_SIZE = 50;
export const MIN_PAGE_SIZE = 1;
/** Forge's own ceiling, and a page an agent can actually read in one go. */
export const MAX_PAGE_SIZE = 100;

/** A generous bound for a name, a domain, a branch — and a hard stop for prose. */
const MAX_TEXT = 200;
/** URLs and paths are allowed a little more room than a name. */
const MAX_URL = 400;
/** Enough alias domains to be useful; not however many a payload wants to send. */
const MAX_LIST_ITEMS = 25;

/**
 * The shape a value must have to be spliced into an API path.
 *
 * Deliberately the same discipline `src/org.ts` applies to the organization slug,
 * and deliberately a separate copy: that predicate is private to the resolver, and
 * an identifier that reaches `/orgs/{org}/servers/{server}` from a TOOL ARGUMENT is
 * chosen by the model, which is the less trusted of the two sources. Anything
 * carrying a slash, a scheme, a query string or a traversal segment could re-point
 * the call at another path entirely, so only Forge's own id/slug shape is accepted.
 */
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

/**
 * A pagination cursor is opaque, but not arbitrary: Laravel encodes one as URL-safe
 * base64 (`+/` swapped for `-_`), so that alphabet is the whole legitimate range.
 * Bounding it matters in both directions — the value lands in a query string that
 * `describeHttpFailure` can echo back into an error message, so a cursor must not be
 * able to carry a traversal segment or a sentence the agent reads. An earlier draft
 * allowed `.` and `/` "because base64 sometimes has them"; it accepted `../../admin`.
 */
const CURSOR_PATTERN = /^[A-Za-z0-9_=-]{1,512}$/;

function isUsableInPath(value: string): boolean {
  return PATH_SEGMENT_PATTERN.test(value) && !value.includes("..");
}

/**
 * Validates a caller-supplied identifier BEFORE it can reach a URL.
 *
 * The rejected value is never echoed: this message is read by a model, and a
 * rejected argument is exactly where hostile text would be planted to get itself
 * repeated back into the transcript.
 */
export function requirePathSegment(raw: unknown, field: string): string {
  const value =
    typeof raw === "number" && Number.isInteger(raw) && raw > 0
      ? String(raw)
      : typeof raw === "string"
        ? raw.trim()
        : "";

  if (!value || !isUsableInPath(value)) {
    throw new ForgeError(
      `${field} is missing or is not a usable Forge identifier. It is placed directly into the Forge API path, so it must be the id Forge issued for the resource — letters, digits, dots, hyphens and underscores only, with no slashes, scheme or ".." segments. The value supplied is not repeated here; read a valid id from list_servers.`,
    );
  }
  return value;
}

export interface PageArgs {
  pageSize: number;
  cursor: string | undefined;
}

/** Reads and bounds `page_size` / `cursor` from a tool's arguments. */
export function readPageArgs(args: Record<string, unknown>): PageArgs {
  return {
    pageSize: readPageSize(args["page_size"]),
    cursor: readCursor(args["cursor"]),
  };
}

function readPageSize(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_PAGE_SIZE;

  // A model may send "25" where the schema says number; a decimal or a word is a
  // mistake worth naming rather than silently rounding into a different request.
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^[0-9]{1,6}$/.test(raw.trim())
        ? Number(raw.trim())
        : Number.NaN;

  if (
    !Number.isInteger(value) ||
    value < MIN_PAGE_SIZE ||
    value > MAX_PAGE_SIZE
  ) {
    throw new ForgeError(
      `page_size must be a whole number between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}. Omit it for the default of ${DEFAULT_PAGE_SIZE}, and follow next_cursor for more results.`,
    );
  }
  return value;
}

function readCursor(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || !CURSOR_PATTERN.test(raw.trim())) {
    throw new ForgeError(
      "cursor is not a usable pagination cursor. Pass back exactly the next_cursor value a previous list call returned, or omit it for the first page.",
    );
  }
  return raw.trim();
}

/** Appends Forge's cursor-pagination parameters to a path. */
export function withPageQuery(path: string, page: PageArgs): string {
  const params = [`page[size]=${page.pageSize}`];
  if (page.cursor !== undefined) {
    params.push(`page[cursor]=${encodeURIComponent(page.cursor)}`);
  }
  return `${path}?${params.join("&")}`;
}

export interface PageInfo {
  /** Pass back as `cursor` to fetch the next page; null when this is the last one. */
  next_cursor: string | null;
  /** True whenever Forge says more rows exist — the honest answer even if the
   * cursor itself was unusable, so a caller is never told "that was everything". */
  has_more: boolean;
}

/** Reads the pagination cursor out of a list response's `meta`. */
function readPageInfo(meta: unknown): PageInfo {
  const raw = record(meta)?.["next_cursor"];
  const present = typeof raw === "string" && raw.length > 0;
  return {
    next_cursor: present && CURSOR_PATTERN.test(raw) ? raw : null,
    has_more: present,
  };
}

/** A page of projected rows, and everything a caller needs to read it correctly. */
export interface PagedRows<T> extends PageInfo {
  rows: T[];
  count: number;
  /**
   * Anything about THIS page a caller would otherwise have to infer, said in
   * words. Empty on an unremarkable page — which is the common case, so the
   * presence of an entry is itself the signal.
   */
  notes: string[];
}

/**
 * Assembles the pagination half of a list result.
 *
 * Two things go wrong quietly here, and neither is left to inference:
 *
 * 1. `page_size` bounds the REQUEST. Forge decides what it actually sends, and a
 *    500-row answer to a request for 50 is a third of a megabyte spent in the
 *    agent's context without anyone asking for it. The overflow is dropped here,
 *    after projection — and dropping rows in silence is precisely the failure this
 *    function exists to prevent, so the note states how many went and that paging
 *    will not bring them back.
 * 2. `has_more: true` with `next_cursor: null` is internally honest and externally
 *    unreadable: two fields a model was never told to compare, whose combination
 *    means "rows are missing and cannot be fetched". It is spelled out instead of
 *    being left as a puzzle whose wrong answer is "that was everything".
 */
export function paginate<T>(
  rows: T[],
  page: PageArgs,
  meta: unknown,
): PagedRows<T> {
  const upstream = readPageInfo(meta);
  const notes: string[] = [];

  const kept = rows.length > page.pageSize ? rows.slice(0, page.pageSize) : rows;
  const dropped = rows.length - kept.length;
  // Rows were dropped, so rows certainly remain — whatever `meta` claimed.
  const has_more = upstream.has_more || dropped > 0;

  if (dropped > 0) {
    notes.push(
      `Forge ignored page_size: it returned ${rows.length} rows for a request of ${page.pageSize}. Only the first ${kept.length} are shown and ${dropped} were dropped to keep this result a readable size. next_cursor, where present, continues after all ${rows.length} rows, so the dropped rows are not reachable by paging.`,
    );
  } else if (has_more && upstream.next_cursor === null) {
    notes.push(
      "More rows exist, but Forge did not return a pagination cursor this server can use, so there is no way to ask for them. Treat this page as incomplete rather than as the whole list.",
    );
  }

  return {
    rows: kept,
    count: kept.length,
    next_cursor: upstream.next_cursor,
    has_more,
    notes,
  };
}

/**
 * The `data` array a list response must carry.
 *
 * A payload that is not what this server understands must not read as "the account
 * has none" — an agent told there are no servers stops looking, and a `data` that
 * arrived as an object or a string is not evidence of an empty account. The same
 * distinction `src/org.ts` draws for a malformed `/orgs` payload: an empty ARRAY is
 * the answer "none", anything else is the absence of an answer.
 *
 * Nothing from the response is quoted back — a malformed body is exactly where
 * text written to be read by a model would be planted.
 */
export function requireList(value: unknown, resource: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new ForgeError(
    `Forge's response carried no ${resource} list, so this call cannot say whether any ${resource} exist. This is not the same as an empty account — do not report that there are none. Retry once; if it persists, the Forge API response shape has changed and this server needs updating.`,
  );
}

/** The single resource object a detail response must carry. Same reasoning. */
export function requireResource(
  value: unknown,
  resource: string,
): Record<string, unknown> {
  const resource_record = record(value);
  if (resource_record === undefined) {
    throw new ForgeError(
      `Forge's response carried no ${resource} record, so this call cannot describe the ${resource}. Do not report its fields as empty or unknown. Retry once; if it persists, the Forge API response shape has changed and this server needs updating.`,
    );
  }
  return resource_record;
}

/* ------------------------------------------------------------------ coercion */

/** A plain object, or undefined — never an array, never a primitive. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A bounded string, or null. Anything non-string becomes null, not "[object Object]". */
export function text(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** A bounded URL-ish string. */
export function url(value: unknown): string | null {
  return text(value, MAX_URL);
}

export function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A bounded list of bounded strings; non-string entries are dropped. */
export function textList(value: unknown): string[] {
  return items(value)
    .slice(0, MAX_LIST_ITEMS)
    .map((entry) => text(entry))
    .filter((entry): entry is string => entry !== null);
}

/**
 * The two pagination arguments every list tool takes, described once.
 *
 * The description is what a model reads when it decides whether to page again, so it
 * says what the cursor is and where it came from — not what cursor pagination is.
 */
export const pageShape = {
  page_size: z
    .number()
    .int()
    .min(MIN_PAGE_SIZE)
    .max(MAX_PAGE_SIZE)
    .optional()
    .describe(
      `How many rows to return, ${MIN_PAGE_SIZE}-${MAX_PAGE_SIZE} (default ${DEFAULT_PAGE_SIZE}).`,
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      "The next_cursor returned by a previous call; omit it for the first page.",
    ),
};
