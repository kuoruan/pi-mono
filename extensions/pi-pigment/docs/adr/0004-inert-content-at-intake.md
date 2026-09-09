# 0004 — Inert content at intake (terminal-injection defense)

Status: **Accepted**

## Context

A code review traced a real attack path: bytes of user-controlled content — file contents in write/edit diffs, grep hit lines, ls entries — flow into our rendered ANSI output **as-is**. A malicious repository file carrying an OSC 52 payload (`ESC]52;c;… BEL`) reaches the terminal verbatim when the agent edits or greps it; on kitty/iTerm2/WezTerm (some by default) that writes the user's clipboard. CSI cursor sequences and raw CR can likewise rewrite the screen. The threat model is the classic data/action distinction: the user approved _reading_ a file (a data operation), not _issuing terminal control_ (an action). That bash can execute commands is no counter-argument — command execution is an explicitly approved action path; tool-output rendering is a data path and must be side-effect-free.

**Surveyed facts (pi 2.7.0):**

- The SDK's bash executor sanitizes at its exit (`stripAnsi(sanitizeBinaryOutput(…))`) — bash output arrives ANSI-free.
- The SDK's built-in grep/read/ls renderers route through `getTextOutput`, which applies the same sanitize — but by **stripping** (first all ANSI via stripAnsi, then filtering control chars): content the file legitimately contains, such as ANSI-art escape text, is silently altered.
- The SDK's built-in **diff renderer does not sanitize at all** (`renderDiff` passes line content through `theme.fg` verbatim) — the built-in path shares the vulnerability. Fixing ours is therefore not a parity deviation; it exceeds the built-in. (Worth reporting upstream as a separate issue.)

## Decision

**User data is inert by construction.** Every byte of user data entering the render pipeline is neutralized **at the intake boundary** — before similarity analysis, highlighting, wrapping, or measurement ever see it. Downstream code structurally cannot encounter a raw control character in content.

### The function

`inertText` (core/ansi.ts) maps control characters to visible caret notation — cat -v semantics: `ESC` → `^[`, `CR` → `^M`, `DEL` → `^?`, C1 code points (U+0080–U+009F) → their C0-equivalent caret. The rule is total: all of C0 except tab and newline, plus DEL, plus C1 — no per-character "dangerous vs harmless" judgment, no gaps. Tab and newline pass through: tabs belong to `expandTabs`, and newlines are line _structure_ (the write path inerts whole multi-line content), not payload.

**Visualization, never deletion.** A diff tool must be honest about what the file contains: a line with a raw ESC displays `^[`. This also fixes a pre-existing non-malicious bug — CRLF files' trailing `CR` used to move the cursor to column 0, overwriting the gutter; it now renders as a visible `^M`.

### The intakes

Six call-site groups at adoption-time plus two added later under the same principle (each one line):

1. `parseOneFile` / `parseDiff` (core/diff.ts) — `DiffLine.content` is inert at construction, so word-diff similarity, highlighting, measurement, and wrapping all operate on the same inert text.
2. `parseHitLine` (render/tool-grep.ts) — both the path and content fields (filenames can carry control bytes too).
3. The write path's `rawContent` (render/tool-write.ts) — model-authored content gets the same treatment as file reads.
4. ls entries — through the shared `outputMemoOf` derivation (render/tool-output.ts), which every grep/find/ls render path reads.
5. find entries — same derivation as ls (the per-line re-inert in the renderers is idempotent belt-and-suspenders).
6. The bash/powershell command (render/shell-tool.ts) — added when command coloring landed: the COMMAND is model-authored data (unlike the output, which the SDK executor already sanitizes upstream — re-neutralizing output would be dead code).

### Why intake, not sink

Sanitizing at the output sink (or inside `hlBlock`) would corrupt downstream invariants: ESC → `^[` changes a one-character escape into two visible columns, misaligning every span computed against the raw text — word-diff ranges, Shiki token spans, wrap offsets. The intake is the only point where all downstream computation stays consistent. It is also the narrowest perimeter: four producers, versus a sink per tool per view.

### The property test

The security contract is asserted as a property, not snapshots: after rendering content carrying OSC 52 and CSI payloads, **every escape sequence in the output is an SGR** (`ESC[…m` from our palette) — `/\x1b(?!\[)/` must find nothing. Paired with a display-honesty assertion (the payload is _visible_ as `^[]52;c;…`), and a grep-path discriminator.

## Consequences

- Content containing control characters renders visibly differently (`^[` forms) — this is correctness, not regression: it displays what is actually in the file.
- One O(n) scan per line at intake, zero-allocation fast path for clean text (the overwhelming case); negligible against Shiki tokenization.
- Width math stays correct: caret forms are plain ASCII (`^` + one char).
- The built-in renderers' stripping approach (grep/read/ls) loses information where ours preserves it; our diff/grep/ls/write surfaces are strictly safer than the built-in diff path and no less honest than anything in the SDK.
- Upstream pi should adopt an equivalent defense in its built-in diff renderer; that is an upstream issue, not ours to block on.
