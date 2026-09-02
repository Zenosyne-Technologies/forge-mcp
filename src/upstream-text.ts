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
 * variation selectors — a class the list never mentioned — while the visible
 * transcript read as an ordinary 404. Widening it to name variation selectors,
 * surrogates and the blank Hangul fillers would fix those three and leave the next
 * unnamed class open, and "invisible" is not a property Unicode enumerates for us:
 * new code points are assigned every release, and an unassigned one today renders
 * as nothing everywhere. A blacklist has to be right about every character that
 * exists and every character that will exist. An allowlist has to be right about
 * the characters this product actually carries — hostnames, server names, git
 * branches, Forge's own diagnostics — and fails CLOSED for everything else,
 * including whatever Unicode adds next.
 *
 * THE ALLOWLIST. A character survives only if it is a letter, a digit, punctuation,
 * a symbol or a mark (`\p{L}\p{N}\p{P}\p{S}\p{M}`).
 *
 * `\p{M}` is in that list on purpose, and the reason is the whole point of the
 * control. The property being bought is VISIBILITY: whatever the model reads, a
 * human auditing the transcript can see. A Devanagari virama, a Thai vowel sign and
 * an Arabic harakat all render on their base character — they are visible, so they
 * satisfy the rule. Excluding them bought no security and cost correctness: `सर्वर`
 * came out as `सर वर`, `เซิร์ฟเวอร์` as five fragments, `خَادِم` as three. An account
 * whose servers are named in Hindi, Thai or Arabic would have reached the agent as
 * broken pieces of its own words. The smuggling channel was never "marks" — it was
 * variation selectors and the U+E0000 tag block, both of which are
 * `Default_Ignorable_Code_Point` and are denied below for exactly that reason.
 *
 * THE DENIALS. Two of them, and neither is a list of characters.
 *
 *  - Everything outside the allowlist. Controls and format characters
 *    (`\p{Cc}\p{Cf}`) — newlines and tabs that forge document structure, the
 *    bidirectional overrides, the zero-width characters. Lone surrogates (`\p{Cs}`),
 *    private use (`\p{Co}`) and unassigned code points (`\p{Cn}`). Line and
 *    paragraph separators and every exotic space (`\p{Zl}\p{Zp}\p{Zs}`), so U+2028,
 *    U+2029, NBSP and the ideographic space collapse into the ordinary run of
 *    whitespace rather than being enumerated one at a time.
 *  - `Default_Ignorable_Code_Point`, plus U+2800. These two render as nothing while
 *    sitting INSIDE the allowed categories, so the categories cannot catch them. The
 *    default-ignorables are where the variation selectors (`Mn`), the tag block, the
 *    zero-width joiner and space, the bidi controls and the Hangul fillers U+115F,
 *    U+1160, U+3164 and U+FFA0 (classified `Lo` — letters, by Unicode's reckoning,
 *    that draw no glyph at all) all live. U+2800 BRAILLE PATTERN BLANK is an `So`
 *    symbol whose entire appearance is empty space. `Default_Ignorable_Code_Point`
 *    is a Unicode-maintained property, so that half of the deny list keeps growing
 *    without this file being edited.
 *
 * DENIED HOW. A denied character is not uniformly replaced by a space, because a
 * space is itself a claim — it says "there was a gap here". Substituting one where
 * the reader would have seen none corrupts the text: `re` + ZWSP + `boot` renders to
 * a human as the single word `reboot`, and emitting `re boot` invents a seam nobody
 * could see. So the two denials are spent differently, each matching what the
 * character actually occupied on screen:
 *
 *  - Zero-width — `Default_Ignorable_Code_Point` — is DELETED. It advanced the pen
 *    by nothing, so removing it leaves the rendered text exactly as it rendered,
 *    minus the payload. This is the class that carried the attack, and it is also
 *    the class that never separated two words.
 *  - Everything else denied becomes a SPACE. A control character, a separator, an
 *    exotic space, a lone surrogate, an unassigned code point and U+2800 all occupy
 *    width — a line break, a blank, a replacement box. Deleting those WOULD fuse two
 *    words: `line one` + LF + `line two` must not arrive as `line onetwo`. A space is
 *    the honest rendering of a gap that was really there.
 *
 * WHAT THIS COSTS, stated plainly rather than discovered later. Text is normalised
 * to NFC after the zero-width deletion, so a decomposed accent ("e" + U+0301)
 * composes to "é"; a mark with no precomposed form now survives as a mark instead of
 * being dropped, which is what restores the Indic, Thai, Arabic and Hebrew cases.
 * Emoji ZWJ sequences still separate into their component emoji — the joiner is
 * default-ignorable — so a family arrives as three people, and an emoji's variation
 * selector still goes, so a red heart loses its colour. Both are VISIBLE losses: a
 * human auditing the transcript sees exactly what the model saw, which is the
 * property being bought. A run of stacked marks now survives as a run of stacked
 * marks — it renders as an unreadable smear rather than as clean text, which is
 * again visible, and the per-field length bounds cap how much of it there can be.
 */

/**
 * Zero-width: the characters that are deleted rather than spaced.
 *
 * `Default_Ignorable_Code_Point` is Unicode's own answer to "should render as
 * nothing", which is precisely the set for which a substituted space would be a
 * fabricated gap. It is also the set the smuggling proof of concept lived in.
 */
const ZERO_WIDTH = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * Anything that is not a letter, a digit, punctuation, a symbol or a mark — plus the
 * one blank-rendering symbol that is.
 *
 * By the time this runs the zero-width characters are already gone, so everything it
 * matches occupied width and a space is the truthful replacement.
 *
 * The `u` flag is what makes `\p{...}` mean a Unicode property rather than a literal
 * `p`, what makes an astral code point (a tag character, a supplementary variation
 * selector) match as one unit instead of as two surrogate halves, and what lets a
 * lone surrogate — a half with no partner — match as itself.
 */
const NOT_VISIBLE_TEXT = /[^\p{L}\p{N}\p{P}\p{S}\p{M}]|\u2800/gu;

/**
 * Put one fragment of upstream text into the single, visible, flattened form both
 * paths render.
 *
 * Order is deliberate.
 *
 * Zero-width deletion runs FIRST, before normalisation, for two reasons: it is a
 * pure code-point removal that depends on no normal form, and running it first lets
 * a base and its mark meet. U+034F COMBINING GRAPHEME JOINER is itself
 * default-ignorable and exists only to hold two characters apart; once it is gone,
 * NFC composes what it was separating instead of leaving a decomposed pair behind.
 *
 * NFC runs next, so a decomposed accent becomes the precomposed letter it means.
 *
 * Space substitution runs after that, on characters that all had width.
 *
 * The whitespace collapse runs last, so the spaces this rule introduced, the runs
 * Forge sent, and the columns a payload tried to paint all end as a single space.
 *
 * The result is a single line of characters a human can see, or the empty string.
 */
export function neutraliseUpstreamText(raw: string): string {
  return raw
    .replace(ZERO_WIDTH, "")
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
