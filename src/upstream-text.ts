/**
 * The one rule for text this server did not write.
 *
 * Both paths that put upstream words into the agent's context go through here: the
 * failure path (`src/errors.ts`, quoting what Forge said about a request) and the
 * success path (`src/tools/common.ts`, copying a server name, a site domain, an
 * alias, a branch). They are the same channel with the same threat and the same
 * reader — a model that will hold `reboot_server` and `update_deployment_script` —
 * so they get one definition of what is safe, in one module neither of them owns.
 * Two copies of a rule are two rules the moment one is edited.
 *
 * The rule is an ALLOWLIST, and that is the load-bearing decision. The blacklist it
 * replaces (`\p{Cc}\p{Cf}` plus two separators) was not merely incomplete, it was
 * incompletable: a proof of concept smuggled 56 bytes of hidden ASCII through
 * variation selectors — `\p{Mn}`, a category the list never mentioned — while the
 * visible transcript read as an ordinary 404. Widening it to name variation
 * selectors, combining marks, surrogates and the blank Hangul fillers would fix
 * those four and leave the next unnamed class open, and "invisible" is not a
 * property Unicode enumerates for us: new code points are assigned every release,
 * and an unassigned one today renders as nothing everywhere. A blacklist has to be
 * right about every character that exists and every character that will exist. An
 * allowlist has to be right about the characters this product actually carries —
 * hostnames, server names, git branches, Forge's own English diagnostics — and
 * fails CLOSED for everything else, including whatever Unicode adds next.
 *
 * So: a character survives only if it is a letter, a digit, punctuation or a symbol
 * (`\p{L}\p{N}\p{P}\p{S}`), which is every character that carries a visible mark of
 * its own. Everything else becomes a space. That is one decision with three
 * consequences worth naming, because each closes a filed defect:
 *
 *  - Controls and format characters (`\p{Cc}\p{Cf}`) are outside it, so the whole of
 *    the previous rule is still enforced: newlines and tabs that forge document
 *    structure, the bidirectional overrides, the zero-width characters, and the
 *    U+E0000 tag block that encodes arbitrary ASCII in glyphs that render as nothing.
 *  - Combining marks (`\p{M}`), lone surrogates (`\p{Cs}`), private use (`\p{Co}`)
 *    and unassigned code points (`\p{Cn}`) are outside it too — none of them was
 *    named by the old rule, and the first two are what the proof of concept used.
 *  - Line and paragraph separators and every exotic space (`\p{Zl}\p{Zp}\p{Zs}`) are
 *    outside it, so U+2028, U+2029, NBSP and the ideographic space collapse into the
 *    ordinary run of whitespace rather than being enumerated one at a time.
 *
 * Two classes render as nothing while sitting INSIDE those categories, so they are
 * denied explicitly rather than left to the categories: the default-ignorable code
 * points (which is where the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0 hide,
 * classified `Lo` — letters, by Unicode's reckoning, that draw no glyph at all), and
 * U+2800 BRAILLE PATTERN BLANK, a `So` symbol whose entire appearance is empty
 * space. `Default_Ignorable_Code_Point` is a Unicode-maintained property, so that
 * half of the deny list keeps growing without this file being edited.
 *
 * What this costs, stated plainly rather than discovered later: text is normalised
 * to NFC first, so accented Latin written in decomposed form ("e" + U+0301)
 * composes to "é" and survives — but a combining mark with no precomposed form is
 * dropped, which mangles scripts that require them (Devanagari, Thai, Arabic
 * diacritics) into their unmarked consonants. Emoji ZWJ sequences separate into
 * their component emoji and an emoji's variation selector goes, so a family becomes
 * three people and a hearts glyph loses its colour. Every one of those outcomes is
 * VISIBLE — a human auditing the transcript sees exactly what the model saw, which
 * is the property being bought. Forge identifiers are hostnames, branches and
 * account-chosen names; accented Latin, CJK and emoji all survive intact.
 */

/**
 * Anything that is not a letter, a digit, punctuation or a symbol — plus the two
 * classes of blank-rendering character that are.
 *
 * The `u` flag is what makes `\p{...}` mean a Unicode property rather than a literal
 * `p`, what makes an astral code point (a tag character, a supplementary variation
 * selector) match as one unit instead of as two surrogate halves, and what lets a
 * lone surrogate — a half with no partner — match as itself.
 */
const NOT_VISIBLE_TEXT =
  /[^\p{L}\p{N}\p{P}\p{S}]|[\p{Default_Ignorable_Code_Point}\u2800]/gu;

/**
 * Put one fragment of upstream text into the single, visible, flattened form both
 * paths render.
 *
 * Order is deliberate. NFC composition runs first, so a decomposed accent becomes
 * the precomposed letter it means before the mark that formed it is judged; running
 * it afterwards would compose nothing, because the mark would already be a space.
 * Neutralisation runs next, turning every non-rendering code point into a space
 * rather than deleting it — deletion would let `re` + ZWSP + `boot` read as one
 * word, where substitution leaves the seam visible. The whitespace collapse runs
 * last, so the spaces this rule introduced, the runs Forge sent, and the columns a
 * payload tried to paint all end as a single space.
 *
 * The result is a single line of characters a human can see, or the empty string.
 */
export function neutraliseUpstreamText(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(NOT_VISIBLE_TEXT, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Cut text to a length without splitting a character in half.
 *
 * A plain `slice` counts UTF-16 units, so a cut that lands between the two halves of
 * an astral character — an emoji, a CJK extension ideograph — leaves a lone
 * surrogate behind. That would be this module re-introducing, at the truncation
 * step, exactly the class `neutraliseUpstreamText` just removed: an unpaired
 * surrogate renders as a replacement box or as nothing, depending on the reader.
 * Both bounds in this codebase (the 200-character error fragment, the per-field
 * caps) therefore cut through here.
 */
export function boundToLength(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  // A high surrogate in the final position had its partner cut away; drop it.
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
