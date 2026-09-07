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
 * TWO FUNCTIONS, ONE RULE. `neutraliseUpstreamText` flattens a value to a single
 * line, and is what every name, domain, alias, branch and status goes through.
 * `neutraliseUpstreamScript` keeps line breaks, and exists for the one value whose
 * line structure IS its content: a site's deployment script, where collapsing the
 * newlines runs five commands together into a sentence no operator can read back.
 * They are variants and not two rules: both are built from the single allowlist
 * string below, and the second spares exactly the three code points in
 * `SCRIPT_SPARED` — space, tab and line feed, the whitespace of ordinary code — more
 * than the first. Everything invisible is removed by both, identically — which is
 * asserted, character by character over the whole code space, rather than asserted
 * in this comment.
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
 * THE allowlist, as the body of a character class, written once.
 *
 * A letter, a digit, punctuation, a symbol or a mark. Every rule in this module is
 * built from this one string rather than from a regex literal of its own, because
 * there are now two callers of it — the flat rule below and the script rule after it
 * — and two literals would be two allowlists the moment one of them was edited. That
 * is the argument this module makes for living in one file at all, applied one level
 * down: the file stops being the single definition of "safe" the moment it holds two
 * definitions of its own.
 *
 * Exported so a test can assert both patterns are built from this and not from a
 * copy. The sweep in `test/upstream-text.test.ts` then proves it behaviourally, by
 * requiring the two functions to agree on every code point outside `SCRIPT_SPARED`.
 */
export const ALLOWED_VISIBLE_CLASSES = "\\p{L}\\p{N}\\p{P}\\p{S}\\p{M}";

/**
 * The entire difference between the two rules, as the characters themselves.
 *
 * U+0020 SPACE, U+0009 TAB and U+000A LINE FEED: the whitespace an author of shell
 * actually types, and the only characters the script variant admits that the flat
 * variant does not. Every one of them advances the pen — a space and a tab move it
 * along the line, a line feed moves it down — so none of them can be used to hide a
 * payload the way a zero-width character can, and none of them is ambiguous about
 * where a line ends the way U+2028, U+0085 or a lone U+000D are.
 *
 * Tab is spared for the same reason space is: in a script it is ordinary content.
 * `\p{Cc}` was denied wholesale because of ESC, NUL and BEL — characters that drive
 * a terminal — not because of the tab in a Makefile or a heredoc.
 *
 * This constant, not a regex literal, is what the script pattern is built from, and
 * it is exported so the drift sweep can exclude EXACTLY this set from its
 * character-by-character comparison and assert this set survives byte-for-byte.
 * Adding a character here without the sweep noticing is therefore not possible: the
 * sweep reads the same string the pattern does.
 */
export const SCRIPT_SPARED = " \t\n";

/**
 * Everything the allowlist denies — optionally sparing the characters in `spared`.
 *
 * `spared` is the ONLY axis on which the two rules below differ, and it is a
 * character-class fragment rather than a boolean so the difference reads as what it
 * is: the script rule admits exactly the three code points of `SCRIPT_SPARED` more
 * than the text rule does.
 *
 * The `u` flag is what makes `\p{...}` mean a Unicode property rather than a literal
 * `p`, what makes an astral code point (a tag character, a supplementary variation
 * selector) match as one unit instead of as two surrogate halves, and what lets a
 * lone surrogate — a half with no partner — match as itself.
 *
 * U+2800 is named beside the class because it is a symbol the allowlist admits and
 * that draws nothing at all.
 */
function denialPattern(spared = ""): RegExp {
  return new RegExp(`[^${ALLOWED_VISIBLE_CLASSES}${spared}]|\\u2800`, "gu");
}

/**
 * Anything that is not a letter, a digit, punctuation, a symbol or a mark — plus the
 * one blank-rendering symbol that is.
 *
 * By the time this runs the zero-width characters are already gone, so everything it
 * matches occupied width and a space is the truthful replacement.
 */
const NOT_VISIBLE_TEXT = denialPattern();

/**
 * The same denial, sparing exactly `SCRIPT_SPARED` and nothing else.
 *
 * Written as `\uXXXX` escapes computed from that string rather than as a literal
 * `" \\t\\n"`, so there is one place a character can be added to the spared set and
 * the pattern, the module comment and the drift sweep all read it.
 *
 * One newline character, so that "a line" means the same thing to the model reading
 * the result, to the human auditing the transcript, and to this file. U+2028 LINE
 * SEPARATOR, U+2029 PARAGRAPH SEPARATOR, U+0085 NEXT LINE, U+000B, U+000C and a lone
 * U+000D all stay denied: each of them begins a new line in SOME renderer and not in
 * others, and a disagreement about where a line ends is exactly the seam a payload
 * paints forged structure into. A carriage return is the sharpest of them — on a
 * terminal it moves the cursor back over what was already printed, so what is
 * displayed is not what was sent — so the only one that survives here is the one in
 * a CRLF pair, and it survives by being rewritten to a line feed before this pattern
 * ever sees it.
 *
 * Horizontal whitespace is a different case entirely, and that is why space and tab
 * are here. They cannot forge a line, they are what indentation and alignment are
 * made of, and in a shell script that indentation is frequently the CONTENT — a
 * heredoc writing an nginx block or a Python body, an `awk -F'  '` whose field
 * separator is two spaces, an `echo "col1    col2"` whose columns are the point.
 */
const NOT_VISIBLE_SCRIPT = denialPattern(
  [...SCRIPT_SPARED]
    .map(
      (char) =>
        `\\u${(char.codePointAt(0) as number).toString(16).padStart(4, "0")}`,
    )
    .join(""),
);

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
 * The same rule for a value whose LINE STRUCTURE is content: a deployment script.
 *
 * Why a second function rather than the one above. A deployment script is multi-line
 * shell, and `neutraliseUpstreamText` collapses every whitespace run to one space —
 * so a five-line script arrives as
 *
 *     cd /home/forge/example.com git pull origin main composer install --no-dev …
 *
 * which is not merely ugly. It is WRONG: the newlines were the only thing saying
 * where one command ended and the next began, and an operator reading that cannot
 * tell whether `git pull origin main composer install` is one command or two.
 * Returning it is worse than returning nothing, because it reads as a faithful copy.
 *
 * Why the flat rule is still right everywhere else. A newline in a server NAME, a
 * site domain, an alias or a git branch is not content — nothing legitimate puts one
 * there, and the only reason to send one is to paint rows, headers or a fake end of
 * output into a field the reader expects to be a single word. In a script a newline
 * is the author's own punctuation. So the difference between the two functions is a
 * judgement about the FIELD, not a relaxation of the rule: the script pattern spares
 * the three characters of `SCRIPT_SPARED` and denies everything the other denies,
 * out of the same allowlist string, so neither can be widened without widening both.
 *
 * What is still removed, unchanged from the flat rule: every
 * `Default_Ignorable_Code_Point` (deleted — the variation selectors, the tag block,
 * the zero-width joiner and space, the bidi controls, the blank Hangul fillers) and
 * U+2800; everything outside the allowlist becomes a space; the whole is NFC.
 *
 * What is different, and only this:
 *
 *  - CRLF becomes LF, so a Windows-authored script keeps its lines instead of
 *    growing a stray space at the end of every one of them. This step is
 *    load-bearing precisely BECAUSE nothing collapses afterwards: a CR that is not
 *    folded into its LF is a denied character that occupied width, so it becomes a
 *    space, and that space would then survive to the end of every line. It runs
 *    after the zero-width deletion because a joiner wedged between the CR and the LF
 *    would otherwise break the pair apart and leave that space behind.
 *  - `SCRIPT_SPARED` survives the denial: U+0020, U+0009 and U+000A. Nothing else
 *    that starts a line does — U+2028, U+2029, U+0085, U+000B, U+000C and a lone
 *    U+000D all become a space, so the result has exactly one kind of line break in
 *    it. Nothing else that is invisible does either.
 *  - There is NO whitespace collapse, in either direction. Horizontal runs are kept
 *    byte-for-byte, because in a script they are content: a heredoc's indentation is
 *    the file being written, a Python body's indentation is its syntax, the spacing
 *    inside `echo "col1    col2"` is the output, and `awk -F'  '` is a different
 *    command from `awk -F' '`. Blank lines are kept for the same reason — they are
 *    the author's paragraphing, and a rule that removed them turned this project's
 *    own recorded 16-line Laravel script into 12 lines that read as the whole thing.
 *
 * WHAT A COLLAPSE WOULD HAVE BOUGHT, and why it is not worth it. Runs of spaces and
 * blank lines can be used to paint a shape or to push the visible end of a script
 * off a reader's screen. But the script is emitted as one JSON string value, whose
 * newlines arrive as `\n` escapes inside a quoted string, so no amount of whitespace
 * inside it can break this server's own framing; and `MAX_SCRIPT_CHARS` already caps
 * how much of anything one call can spend. Trading a correct copy of the script for
 * a defence the framing and the bound already provide is a bad trade — and silently
 * altering the one value whose whole purpose is to say what will run is worse than
 * the shape it prevented.
 *
 * WHAT THIS COSTS, stated rather than discovered later. Leading and trailing
 * whitespace is trimmed off the whole script. A denied character still becomes a
 * space, so a script containing a NBSP, a lone CR or an ESC does not come back
 * byte-identical. NFC still runs. None of that is silent: `scriptText` in
 * `src/tools/common.ts` compares the result with what Forge sent and the tool says
 * in `notes` when the two differ, exactly as it does for a truncated script.
 *
 * The result is the script's own lines and spacing, or the empty string.
 */
export function neutraliseUpstreamScript(raw: string): string {
  return raw
    .replace(ZERO_WIDTH, "")
    .normalize("NFC")
    .replace(/\r\n/g, "\n")
    .replace(NOT_VISIBLE_SCRIPT, " ")
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
