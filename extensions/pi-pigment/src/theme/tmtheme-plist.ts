/**
 * The .tmTheme intake: a minimal, strict XML plist parser for TextMate
 * theme files (the original .tmTheme form the converter accepts alongside
 * the two JSON shapes). The algorithm follows the fast-plist lineage —
 * the same state-machine approach vscode-textmate vendors in its own
 * src/plist.ts for the identical job (the ecosystem's authoritative
 * TextMate engine keeps its plist reader INLINED rather than depending on
 * the stale fast-plist package). Trimmed to the theme subset: dict/key/
 * string/array plus the scalar tags themes carry; date/data are tolerated
 * as inert strings. Malformed input THROWS with the near-offset context —
 * the theme-file loader converts that into a per-file issue.
 */

/** A UTF-8 BOM. */
const BOM = 0xfeff;

/** The plist container states the scanner tracks. */
type State = "root" | "dict" | "array";

/** The five XML named entities plist strings may carry. */
const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

/**
 * Parse a .tmTheme XML plist into a plain object (the TextMate JSON shape
 * the converter consumes: a root dict with a `settings` array). Strict by
 * design — a theme file is static, hand-checkable content, so a parse
 * failure is reported verbatim instead of half-rounded.
 *
 * @param content - The raw file content.
 * @returns The parsed root dict.
 * @throws On malformed input, with the near-offset context.
 */
export function parsePlistTheme(content: string): Record<string, unknown> {
  const len = content.length;
  // A UTF-8 BOM precedes the declaration in some editors' saves.
  let pos = content.charCodeAt(0) === BOM ? 1 : 0;

  const fail = (message: string): never => {
    // The context slice is sanitized (JSON-escaped) — a hostile theme
    // file must never smuggle terminal control sequences into the issue
    // message; the near-offset context survives as a quoted literal.
    throw new Error(
      `invalid plist near offset ${pos}: ${message} ${JSON.stringify(content.slice(pos, pos + 40))}`,
    );
  };

  let state: State = "root";
  let cur: unknown = {};
  let curKey: string | null = null;
  const stateStack: State[] = [];
  const objStack: unknown[] = [];

  const skipWhitespace = (): void => {
    while (pos < len) {
      const code = content.charCodeAt(pos);
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
      pos++;
    }
  };

  const skipUntil = (target: string): void => {
    const at = content.indexOf(target, pos);
    pos = at === -1 ? len : at + target.length;
  };

  const captureThrough = (target: string): string => {
    const at = content.indexOf(target, pos);
    if (at === -1) return fail(`missing "${target}"`);
    const captured = content.slice(pos, at);
    pos = at + target.length;
    return captured;
  };

  const parseOpenTag = (): { name: string; selfClosed: boolean } => {
    const raw = captureThrough(">");
    const selfClosed = raw.endsWith("/");
    const trimmed = (selfClosed ? raw.slice(0, -1) : raw).trim();
    if (trimmed === "") return fail("empty tag name");
    // Only <plist> legitimately carries attributes (version="1.0") — the
    // first whitespace-delimited token is the tag name (the fast-plist
    // lineage special-cases the same tag via a prefix match).
    const name = trimmed.split(/\s+/)[0];
    if (name !== "plist" && name !== trimmed) {
      return fail(`attributes on a non-<plist> tag <${name}>`);
    }
    return { name, selfClosed };
  };

  const decode = (value: string): string =>
    value
      .replace(/&#(\d+);/g, (_whole, digits: string) =>
        String.fromCodePoint(Number.parseInt(digits, 10)),
      )
      .replace(/&#x([0-9a-fA-F]+);/g, (_whole, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      )
      .replace(/&amp;|&lt;|&gt;|&quot;|&apos;/g, (entity) => NAMED_ENTITIES[entity]);

  const parseTagValue = (selfClosed: boolean): string => {
    if (selfClosed) return "";
    // Capture until the closing tag; its name is not validated (the
    // fast-plist lineage trusts the structure once open tags matched).
    const value = captureThrough("</");
    skipUntil(">");
    return decode(value);
  };

  const push = (newState: State, newCur: unknown): void => {
    stateStack.push(state);
    objStack.push(cur);
    state = newState;
    cur = newCur;
  };

  const pop = (): void => {
    const parentState = stateStack.pop();
    const parentCur = objStack.pop();
    if (parentState === undefined || parentCur === undefined) {
      return fail("unbalanced structure");
    }
    state = parentState;
    cur = parentCur;
  };

  const dict = (): Record<string, unknown> => cur as Record<string, unknown>;
  const array = (): unknown[] => cur as unknown[];

  const enterDict = (): void => {
    if (state === "root") {
      // The root container REPLACES the initial holder, then self-parents
      // (the fast-plist lineage assigns cur before the root push, so the
      // final pop re-yields the parsed container).
      cur = {};
      push("dict", cur);
      return;
    }
    if (state === "dict") {
      if (curKey === null) return fail("<dict> needs a preceding <key>");
      const child: Record<string, unknown> = {};
      dict()[curKey] = child;
      curKey = null;
      push("dict", child);
      return;
    }
    const child: Record<string, unknown> = {};
    array().push(child);
    push("dict", child);
  };

  const leaveDict = (): void => {
    if (state !== "dict") return fail("unexpected </dict>");
    pop();
  };

  const enterArray = (): void => {
    if (state === "root") {
      // Like the root dict: assign the container, then self-parent.
      cur = [];
      push("array", cur);
      return;
    }
    if (state === "dict") {
      if (curKey === null) return fail("<array> needs a preceding <key>");
      const child: unknown[] = [];
      dict()[curKey] = child;
      curKey = null;
      push("array", child);
      return;
    }
    const child: unknown[] = [];
    array().push(child);
    push("array", child);
  };

  const leaveArray = (): void => {
    if (state !== "array") return fail("unexpected </array>");
    pop();
  };

  const acceptKey = (key: string): void => {
    if (state !== "dict") return fail("<key> outside a <dict>");
    if (curKey !== null) return fail("consecutive <key>s (missing value)");
    curKey = key;
  };

  const acceptValue = (value: unknown): void => {
    if (state === "dict") {
      if (curKey === null) return fail("value without a preceding <key>");
      dict()[curKey] = value;
      curKey = null;
      return;
    }
    if (state === "array") {
      array().push(value);
      return;
    }
    cur = value; // a root scalar: rejected below (the root must be a dict)
  };

  while (pos < len) {
    skipWhitespace();
    if (pos >= len) break;
    const code = content.charCodeAt(pos);
    pos++;
    if (code !== 60 /* < */) return fail("text outside a tag (expected <)");
    if (pos >= len) return fail("truncated input");
    const peek = content.charCodeAt(pos);
    if (peek === 63 /* ? */) {
      // The XML declaration. An unterminated prologue fails here (the
      // downstream shape errors would mislead — the fast-plist lineage
      // silently tolerates these; the theme intake is stricter).
      pos++;
      if (content.indexOf("?>", pos) === -1) return fail("unterminated <? ?> declaration");
      skipUntil("?>");
      continue;
    }
    if (peek === 33 /* ! */) {
      // A comment (<!-- -->) or the DOCTYPE prologue — both must close.
      pos++;
      if (content.startsWith("--", pos)) {
        if (content.indexOf("-->", pos) === -1) return fail("unterminated comment");
        skipUntil("-->");
      } else {
        if (content.indexOf(">", pos) === -1) return fail("unterminated <! > prologue");
        skipUntil(">");
      }
      continue;
    }
    if (peek === 47 /* / */) {
      pos++;
      skipWhitespace();
      // Closing tags are not name-validated and </plist> may be absent
      // (the unclosed-structure check at EOF still guards truncation).
      if (content.startsWith("plist", pos)) {
        skipUntil(">");
        continue;
      }
      if (content.startsWith("dict", pos)) {
        skipUntil(">");
        leaveDict();
        continue;
      }
      if (content.startsWith("array", pos)) {
        skipUntil(">");
        leaveArray();
        continue;
      }
      return fail("unexpected closing tag");
    }
    const tag = parseOpenTag();
    switch (tag.name) {
      case "plist":
        continue;
      case "dict":
        enterDict();
        if (tag.selfClosed) leaveDict();
        continue;
      case "array":
        enterArray();
        if (tag.selfClosed) leaveArray();
        continue;
      case "key":
        acceptKey(parseTagValue(tag.selfClosed));
        continue;
      case "string":
        acceptValue(parseTagValue(tag.selfClosed));
        continue;
      case "integer": {
        const number = Number.parseInt(parseTagValue(tag.selfClosed), 10);
        if (Number.isNaN(number)) return fail("invalid <integer>");
        acceptValue(number);
        continue;
      }
      case "real": {
        const number = Number.parseFloat(parseTagValue(tag.selfClosed));
        if (Number.isNaN(number)) return fail("invalid <real>");
        acceptValue(number);
        continue;
      }
      case "true":
        parseTagValue(tag.selfClosed);
        acceptValue(true);
        continue;
      case "false":
        parseTagValue(tag.selfClosed);
        acceptValue(false);
        continue;
      case "date":
      case "data":
        // Outside the .tmTheme subset; tolerated as inert strings so a
        // decorated plist does not fail the whole file.
        acceptValue(parseTagValue(tag.selfClosed));
        continue;
      default:
        return fail(`unexpected tag <${tag.name}>`);
    }
  }
  if (state !== "root") return fail("truncated input (unclosed structure)");
  if (typeof cur !== "object" || cur === null || Array.isArray(cur)) {
    return fail("the plist root must be a <dict>");
  }
  return cur as Record<string, unknown>;
}
