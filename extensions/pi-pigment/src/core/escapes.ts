/**
 * The ANSI escape literals, in their one home: every module that emits or
 * compares SGR bytes imports from here instead of repeating `\x1b[...]`
 * literals, so a byte change has exactly one edit site. The sequences are
 * built from SEQ_ESC so the ESC byte itself cannot drift between them.
 *
 * Ansi.ts's grammar (escapeEndAt, forEachCell) is the consumer, not the
 * owner — it imports SEQ_ESC from here; the reverse direction would cycle
 * (ansi.ts takes mixRgb from color.ts, which needs SEQ_ESC too).
 */

/** The ESC control character every ANSI escape sequence starts with. */
export const SEQ_ESC = "\u001b";

/** The BEL terminator closing an OSC sequence. */
export const SEQ_BEL = "\u0007";

/** The SGR reset sequence. */
export const SEQ_RESET = `${SEQ_ESC}[0m`;

/** The bare SGR terminator, an accepted synonym of the full reset. */
export const SEQ_RESET_BARE = `${SEQ_ESC}[m`;

/** The SGR sequence resetting the background to the terminal default. */
export const SEQ_BG_DEFAULT = `${SEQ_ESC}[49m`;

/** The SGR sequence resetting the foreground to the terminal default. */
export const SEQ_FG_DEFAULT = `${SEQ_ESC}[39m`;

/** The SGR sequence closing bold (and dim) back to normal intensity. */
export const SEQ_BOLD_OFF = `${SEQ_ESC}[22m`;

/** The SGR sequence closing italic. */
export const SEQ_ITALIC_OFF = `${SEQ_ESC}[23m`;

/** The SGR sequence closing underline. */
export const SEQ_UNDERLINE_OFF = `${SEQ_ESC}[24m`;

/** The SGR sequence closing strikethrough. */
export const SEQ_STRIKE_OFF = `${SEQ_ESC}[29m`;

/** The dim style's opening escape. */
export const SEQ_DIM = `${SEQ_ESC}[2m`;

/** The bold style's opening escape. */
export const SEQ_BOLD = `${SEQ_ESC}[1m`;

/** The italic style's opening escape. */
export const SEQ_ITALIC = `${SEQ_ESC}[3m`;

/** The underline style's opening escape. */
export const SEQ_UNDERLINE = `${SEQ_ESC}[4m`;

/** The strikethrough style's opening escape. */
export const SEQ_STRIKE = `${SEQ_ESC}[9m`;
