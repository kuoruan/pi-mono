# Theme derivation spec: pi themes to terminal color schemes

Input: a pi theme JSON (`vars`, `colors`, `export`; 53 color tokens; light and dark share the same structure). Output: a color scheme for any terminal format (Windows Terminal JSON, iTerm2 `colors`, kitty `colorN`, base24 YAML, and so on).

Terminal formats name their fields differently, so this spec is organized by part. Each part states its source token, constraints, and derivation rules, then lists the field names per terminal. Extending to a new terminal means walking the parts and filling in its fields. The one existing scheme is `windows-terminal/pi-light.json`, declared level AA (section 6).

## 1. Levels and overall rules

1. Level lines: AA means 4.5:1 for body text; AAA means 7:1; the large-text AA line is 3:1. The only numeric source is WCAG 2.x. base16, base24, and Catppuccin all say "readability first" but give no numbers.
2. Default level: AA for light themes, AAA for dark themes, because dark surfaces reach higher contrast at low cost.
3. Where levels apply: main reading text (fg against bg) always at AAA; the six semantic hues and the bright set at the chosen level; decoration and weak secondary information (dim, separator grays) may drop to 3:1 and must stay limited to non-critical content.
4. Pick the level before picking colors, and verify afterwards (section 5). Every derived color keeps the hue of its source token; no new hues are introduced.

## 2. Workflow

1. Choose anchors: canvas background bg and primary text fg. Every format has these two fields or an equivalent.
2. Extract the theme tokens into the part slots (section 3). Use tokens unchanged wherever they already pass.
3. Correct only the colors below the level line, with HSL corrections (section 3.4).
4. Derive the bright set and the gray ramp from colors already placed (sections 3.3 and 3.5). Do not source new colors.
5. Write the target format using the field map (section 4), run the contrast check, and declare the level and exemptions.

## 3. Parts

### 3.1 Canvas and panel backgrounds

- Source: the theme's canvas color. Pi light has no canvas token (its `export.cardBg` and `export.pageBg` can serve as panel layers where a format needs them); dark themes mirror this.
- Constraints: neutral (chroma near 0); bg against fg at AAA; bg against every placed color (six hues, gray ramp) at the chosen level.
- Rules: a light theme takes an off-white bg with L(bg) in [0.88, 0.95], easier on the eye than pure white and leaving headroom above for the bright set; a dark theme takes a near-black with L at most 0.05. Panel layers are neighbors of bg (ΔL about 0.02 to 0.05), never the main color.
- Fields: WT `background`; iTerm2 `Background Color`; kitty `background`; base24 `base00`.

### 3.2 Primary text and cursor

- Source: `colors.text`. Cursor takes the same color or a semantic accent, and must stay distinguishable from text.
- Constraints: fg against bg at AAA; cursor visible against bg.
- Rules: use the theme's text token unchanged.
- Fields: WT `foreground` / `cursorColor`; iTerm2 `Foreground Color` / `Cursor Color`; kitty `foreground` / `cursor` / `cursor_text_color`; base24 `base05`.

### 3.3 Gray ramp (secondary text and neutral slots)

- Source: `mediumGray` (muted, secondary text), `dimGray` (weaker information), `lightGray` (separators, border level). In 16-slot formats the four neutral slots black, white, brightBlack, brightWhite land in this layer.
- Constraints: muted at the chosen level against bg; dim and decoration level allowed at 3:1, and only for non-critical content; steps between levels stay perceptible.
- Rules: use the theme grays directly; where one falls short, adjust only L as in section 3.4 (a gray has no H to keep). The four neutral slots take members from both ends of this layer. In a light theme the black slot holds a dark gray text color rather than a copy of the background; if the target format renders ANSI slot 0 as the default background, put the canvas color there instead (see the note in section 4).
- Fields: WT `black/white/brightBlack/brightWhite`; iTerm2 ANSI 0/7/8/15; kitty `color0/7/8/15`; base24 `base00/03/05/07`.

### 3.4 Six semantic hues

- Source (fixed mapping): `vars.red` (error), `vars.green` (success), `vars.yellow` (warning), `vars.blue` (links, borders), `vars.teal` (accent, info), `colors.customMessageLabel` (magenta, message labels). Dark themes use the same names.
- Constraints: all six at the chosen level against bg; neighboring hues at least about 40° apart so they stay distinguishable on one screen; corrections keep the hue.
- Correction rules, applied only to colors below the line:
  1. Work in HSL; H may drift at most ±2°.
  2. Light themes lower L in steps of 5 to 9 points; dark themes raise L by the same steps.
  3. S stays unchanged or rises slightly (at most +8 points) to offset the gray cast that comes with lowering L; dark themes may lower S slightly.
  4. Stop inside the target band: [4.5, 5.6] for AA themes, [7, 8] for AAA themes. Overshooting only muddies the color without helping readability.
- Fields: WT `red/green/yellow/blue/cyan/purple`; iTerm2 ANSI 1-6; kitty `color1-6`; base24 `base08/0B/0A/0D/0C/0E`.

### 3.5 Bright set

- Source: derived one by one from the section 3.4 hues, never new hues; brightBlack and brightWhite belong to section 3.3.
- Constraints: same chosen level against bg; distinct from the base color yet in the same family.
- Rules: families with low saturation (S at most about 40) raise S to roughly 1.5 to 2.5 times and nudge L; families with high saturation (S at least about 45) keep S and adjust only L within ±5 points. This matches the base24 guidance on brightness and saturation. Catppuccin publishes whole-set formulas (dark: L times 0.94, C plus 8, H plus 2; light: L times 1.09, H plus 2; written in lightness/chroma/hue terms, without naming a color space) as an alternative starting point for batch derivation.
- Fields: ANSI 9-14; WT `brightRed`/.../`brightCyan`; iTerm2; kitty; base24 `base12-17`.

### 3.6 Selection and highlight blocks

- Source: `vars.selectedBg` (selection), `colors.searchMatchBg` (search hits); block status tints may reuse `toolSuccessBg`, `toolErrorBg`, `toolPendingBg`, `customMsgBg`.
- Constraints: text inside the block (fg or the block's own text color) against the block color at the chosen level; block color visibly different from the canvas.
- Rules: block colors are low-saturation tints layered on the canvas (light tints on light themes, dark tints on dark themes). Selection takes the theme's `selectedBg` family unchanged.
- Fields: WT `selectionBackground`; iTerm2 `Selection Color` / `Selected Text Color`; kitty `selection_background` / `selection_foreground`; base24 `base02`.

### 3.7 Syntax colors (for formats that have them)

- Source: the nine `colors.syntax*` tokens.
- Constraints: the syntax set stays separate from the six UI hues so code does not visually collide with error or warning colors; each syntax color at the chosen level against its own surface (the editor background).
- Rules: formats that support syntax colors (editors, extended 256-color slots) map the nine tokens directly, following base16's practice of assigning one color group per kind of language construct. 16-slot formats do not compress syntax colors: the terminal app's own strategy handles that, and the scheme stays out of it.
- Fields: base24 extended slots (`base01/04/06/09/0F`) can host syntax colors; VS Code and macOS Terminal carry their own syntax systems and get separate files outside the 16-slot mapping.

### 3.8 Small details (borders, scrollbars, accent outlines)

- Tokens that exist (`border`, `borderAccent`, `borderMuted`, `scrollbarTrack`, `scrollbarThumb`) map unchanged; anything without a token takes fg or the nearest gray. No invented colors.

## 4. Part to field map

| Part              | Windows Terminal                      | iTerm2                                    | kitty                                           | base24                  |
| ----------------- | ------------------------------------- | ----------------------------------------- | ----------------------------------------------- | ----------------------- |
| Canvas background | `background`                          | `Background Color`                        | `background`                                    | `base00`                |
| Primary text      | `foreground`                          | `Foreground Color`                        | `foreground`                                    | `base05`                |
| Cursor            | `cursorColor`                         | `Cursor Color`                            | `cursor` / `cursor_text_color`                  | `base05`                |
| Gray ramp         | `black/white/brightBlack/brightWhite` | ANSI 0/7/8/15                             | `color0/7/8/15`                                 | `base00/03/05/07`       |
| Six hues          | `red/green/yellow/blue/cyan/purple`   | ANSI 1-6                                  | `color1-6`                                      | `base08/0B/0A/0D/0C/0E` |
| Bright set        | `brightRed`/.../`brightCyan`          | ANSI 9-14                                 | `color9-14`                                     | `base12-17`             |
| Selection block   | `selectionBackground`                 | `Selection Color` / `Selected Text Color` | `selection_background` / `selection_foreground` | `base02`                |
| Syntax colors     | none (16 slots, terminal's own job)   | none                                      | partial                                         | extended slots          |

Note: a few formats render ANSI slot 0 as the default background (some older terminals). In that case the black slot takes the canvas color instead of a dark gray text color, and the gray ramp from section 3.3 shifts by one slot.

## 5. Acceptance and declaration

- Every scheme must pass a contrast check and declare its level and exemptions next to the file.
- Checker: `node color-schemes/check.js [--target aa|aaa] [--exempt s1,s2] [--dim s1,s2] <scheme.json>`. The exit code is the verdict: 0 all non-exempt slots pass; 1 some slot failed, was invalid, or is missing; 2 usage error, unreadable file, or unknown format. The script separates a format-independent WCAG core from an adapter registry (`ADAPTERS`, currently with `windows-terminal` built in). Adapter ids match `color-schemes/<terminal>/` directory names, so a file is matched by path first and by JSON shape after that. Supporting a new terminal means registering one adapter (`detect` plus canvas extraction, primary, selection, and the 16-slot key spec); the core stays untouched. Non-JSON formats (iTerm2 plist, kitty.conf) will need a file-reading and parsing hook on their adapter. The two tier flags cover per-scheme structure: `--exempt` marks slots that act as surfaces (panel black on dark themes, section 3.6), `--dim` grades slots at the 3:1 floor of the dim tier (section 1.3).
- Exemptions: items that physically cannot reach a level (brightWhite on a light surface) are declared EXEMPT, reported but not counted as failures, and must appear in the declaration.

## 6. Instance records

### windows-terminal/pi-light.json

- Declared level: AA. fg and black are in fact AAA; the six hues and the bright set run from 4.57 to 5.75; brightWhite is EXEMPT at 1.11.
- Decisions recorded:
  - anchor bg = `#F3F3F3` (off-white, L about 0.895, inside the section 3.1 band);
  - gray ramp: black = `#262626` (dark gray text color, see the section 3.3 note), white = `mediumGray`, brightBlack = `#5F5F5F`;
  - six hues: red and purple passed as-is (4.57 and 4.70); blue, green, yellow, and cyan were corrected per section 3.4 (H drift at most 1.6°, L down 6.0 to 9.2 points, S up 1.1 to 7.6 points);
  - bright set per section 3.5 (same families as the six hues, H drift at most 4.4°);
  - selection uses `vars.selectedBg` unchanged.
- Acceptance evidence: `node color-schemes/check.js color-schemes/windows-terminal/pi-light.json` passes AA with brightWhite EXEMPT.

### windows-terminal/pi-dark.json

- Declared level: AAA, the default of section 1.2 for dark themes. Correction list below.
- Canvas and text: bg = `#18181E`, sourced from `export.pageBg` (L about 0.009, inside the section 3.1 band); fg = cursor = `#D4D4D4` from `colors.text` (11.9:1); white = `#C8C8C8`, a soft white just below fg (10.6:1); brightWhite = `#FFFFFF` (17.7:1).
- Structural slots: black = `#31313A`, a panel neighbor of the canvas (ΔL about 0.022, section 3.1), graded `--exempt black` because it acts as a surface; brightBlack = `#666666` from `vars.dimGray`, graded at the dim 3:1 floor (3.1:1, `--dim brightBlack`), mirroring pi's own dim text usage.
- Six hues: green `#B5BD68` (8.8:1), yellow `#FFFF00` (16.5:1), and cyan = `vars.accent` `#8ABEB7` (8.5:1) passed unchanged; red, blue, and purple sat below 7:1 and were corrected per section 3.4 with H fixed at the source value, S unchanged, and L raised into the [7, 8] band: red `#CC6666` to `#DA9090` (7.1:1), blue `#5F87FF` to `#809FFF` (7.0:1), purple `#9575CD` to `#B098DA` (7.0:1).
- Bright set per section 3.5, same families as the six hues (8.0 to 14.5:1): high-saturation red, blue, purple, and yellow kept S and shifted L only (`#DE9B9B`, `#8FABFF`, `#B9A3DE`, `#F0F000`); low-saturation green and cyan raised S to about 1.8 times with a small L nudge (`#D3E14F`, `#7DD5C9`).
- Selection uses `vars.selectedBg` `#3A3A4A` unchanged (fg against it 7.5:1).
- Acceptance evidence: `node color-schemes/check.js --target aaa --exempt black --dim brightBlack color-schemes/windows-terminal/pi-dark.json` passes AAA with black EXEMPT and brightBlack at the dim floor.

Note: pi's own dark theme shows red, blue, and purple at their source values (4.8 to 5.4:1). If visual parity with pi's native look matters more than AAA, reuse the source hexes and declare AA; the record here follows the section 1.2 default.

## 7. Community specifications

| Specification                                                                                    | Version | Referenced from                                                                                  |
| ------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------ |
| [base16 Styling Guidelines](https://github.com/chriskempson/base16/blob/main/styling.md)         | v0.2    | neutral ramp (3.3), syntax semantic grouping (3.7)                                               |
| [base24 styling](https://github.com/tinted-theming/base24/blob/main/styling.md)                  | v0.1.3  | bright guidance (3.5), ANSI slot mapping (4)                                                     |
| [Catppuccin Style Guide](https://github.com/catppuccin/catppuccin/blob/main/docs/style-guide.md) | current | role-based palette model (3.1, 3.6), ANSI derivation formulas (3.5)                              |
| WCAG 2.x                                                                                         | current | level lines (1), acceptance numbers (5)                                                          |
| pi docs `themes.md` "Color harmony"                                                              | current | how the source theme picks its own colors: base palette, then `vars`, then consistent references |

## 8. Directory layout

```
color-schemes/
├── README.md           # this spec
├── check.js           # WCAG checker (core plus terminal adapters)
└── <terminal>/         # one directory per terminal
    └── pi-<theme>.json # one scheme per pi theme, with its level declaration
```

Adding a new terminal means picking colors by section 3, filling its fields via section 4, verifying with section 5, and adding a scheme file under `color-schemes/<terminal>/`.
