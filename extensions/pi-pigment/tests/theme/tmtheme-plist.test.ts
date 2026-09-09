/**
 * The .tmTheme plist intake (tmtheme-plist.ts): the parser unit tests —
 * the full TextMate theme shape, entity decoding, BOM/prologue skipping,
 * scalar typing, and the strict fail-fast paths. Pure parser, no fs mock.
 */
import { describe, expect, it } from "vitest";

import { parsePlistTheme } from "#src/theme/tmtheme-plist.ts";

/** A realistic .tmTheme: global entry first, one rule, entities, comments. */
const TM_THEME = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- a handheld theme -->
<plist version="1.0">
<dict>
	<key>name</key>
	<string>A &amp; B</string>
	<key>semanticClass</key>
	<string>theme.dark</string>
	<key>settings</key>
	<array>
		<dict>
			<key>settings</key>
			<dict>
				<key>background</key>
				<string>#272822</string>
				<key>caret</key>
				<string>#F8F8F0</string>
			</dict>
		</dict>
		<dict>
			<key>name</key>
			<string>Comment</string>
			<key>scope</key>
			<string>comment, punctuation.definition.comment</string>
			<key>settings</key>
			<dict>
				<key>fontStyle</key>
				<string>italic</string>
				<key>foreground</key>
				<string>#75715E &lt;low&gt; &#x2F; &#47;</string>
			</dict>
		</dict>
	</array>
	<key>uuid</key>
	<string>1E4A1B68-46FB-4AC2-8307-001AE5E82C8B</string>
</dict>
</plist>`;

describe("parsePlistTheme", () => {
  it("parses a .tmTheme plist into the TextMate JSON shape", () => {
    expect(parsePlistTheme(TM_THEME)).toEqual({
      name: "A & B",
      semanticClass: "theme.dark",
      settings: [
        { settings: { background: "#272822", caret: "#F8F8F0" } },
        {
          name: "Comment",
          scope: "comment, punctuation.definition.comment",
          settings: { fontStyle: "italic", foreground: "#75715E <low> / /" },
        },
      ],
      uuid: "1E4A1B68-46FB-4AC2-8307-001AE5E82C8B",
    });
  });

  it("keeps scalars typed (integer/real/boolean)", () => {
    const plist = `<plist version="1.0"><dict>
      <key>n</key><integer>3</integer>
      <key>r</key><real>1.5</real>
      <key>t</key><true/>
      <key>f</key><false/>
    </dict></plist>`;
    expect(parsePlistTheme(plist)).toEqual({ n: 3, r: 1.5, t: true, f: false });
  });

  it("tolerates data/date tags as inert strings (outside the theme subset)", () => {
    const plist = `<plist><dict><key>d</key><data>aGVsbG8=</data><key>when</key><date>2020-01-02T03:04:05Z</date></dict></plist>`;
    expect(parsePlistTheme(plist)).toEqual({ d: "aGVsbG8=", when: "2020-01-02T03:04:05Z" });
  });

  it("skips a UTF-8 BOM prefix", () => {
    expect(parsePlistTheme(`\uFEFF${TM_THEME}`)).toEqual(parsePlistTheme(TM_THEME));
  });

  it("throws on text outside tags", () => {
    expect(() => parsePlistTheme(`hello <plist><dict></dict></plist>`)).toThrow(/text outside/);
  });

  it("throws on an unknown tag (never a silent half-parse)", () => {
    const plist = `<plist><dict><key>a</key><mystery>x</mystery></dict></plist>`;
    expect(() => parsePlistTheme(plist)).toThrow(/mystery/);
  });

  it("throws on truncated input (unclosed structure)", () => {
    expect(() => parsePlistTheme(`<plist><dict><key>name</key><string>x</string>`)).toThrow(
      /truncated/,
    );
  });

  it("throws when the plist root is not a dict", () => {
    expect(() => parsePlistTheme(`<plist><array><string>x</string></array></plist>`)).toThrow(
      /dict/,
    );
  });

  it("throws on unbalanced closing tags", () => {
    expect(() => parsePlistTheme(`<plist><dict></dict></dict></plist>`)).toThrow(/unexpected/);
    expect(() => parsePlistTheme(`<plist><array></array></array></plist>`)).toThrow(/unexpected/);
  });

  it("throws on unterminated prologues (never a downstream shape mislead)", () => {
    expect(() => parsePlistTheme(`<?xml version="1.0"`)).toThrow(/unterminated/);
    expect(() => parsePlistTheme(`<plist><!-- comment`)).toThrow(/comment/);
    expect(() => parsePlistTheme(`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"`)).toThrow(
      /unterminated/,
    );
  });

  it("throws on attributes on a non-plist tag and on NaN integers", () => {
    expect(() => parsePlistTheme(`<plist><dict><key a="1">x</key></dict></plist>`)).toThrow(
      /attributes/,
    );
    expect(() =>
      parsePlistTheme(`<plist><dict><key>n</key><integer>abc</integer></dict></plist>`),
    ).toThrow(/integer/);
  });

  it("tolerates the fast-plist lineage's closing-tag looseness (pinned as intentional)", () => {
    // Closing tags are not name-validated and </plist> may be absent —
    // structure is trusted once the open tags matched; the unclosed-
    // structure check at EOF still guards truncation.
    expect(parsePlistTheme(`<plist><dict></dict>`)).toEqual({});
    expect(
      parsePlistTheme(`<plist><dict><key>a</key><string>x</mismatched></dict></plist>`),
    ).toEqual({ a: "x" });
  });
});
