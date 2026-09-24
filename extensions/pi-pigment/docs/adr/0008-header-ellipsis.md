# ADR 0008: Single-Line Call Headers with Ellipsis

## Status

Accepted.

## Context

Long call headers (a 200-char bash command, a deep grep path) push the result body far down and wrap into multiple visual rows. The result body already collapses under ctrl+o; the header had no equivalent — it always rendered in full.

## Decision

- Every tool call header (bash/powershell/grep/find/ls/edit/write) renders as ONE visual row: when the styled line exceeds the render width, the middle is replaced with `…` (single char — every column counts under a width budget; the TUI is Unicode-safe).
- The middle goes because paths/commands carry information at both ends (directory head + file tail, command head + args tail).
- The status suffix (`· ✓` / `· ✗ exit N`) is pinned — never part of the ellipsis budget. State must survive truncation.
- ctrl+o toggles ellipsis/full, reusing the existing expand/collapse state machine. Expanded = the full single line; soft-wrap is the TUI's business, not ours.
- `headerEllipsis: "on" | "off"` (default `"on"`) gates the feature. Off means always-full headers regardless of expand state. It gates the HEADER only — body collapse is untouched.

## Alternatives

- Tail ellipsis (`very-long-co…`): simpler, but drops the file tail — the most informative segment of a path header. Rejected.
- Fixed char budget (80): predictable, but overflows on narrow windows. The width-aware preview task already exists, so width-following costs one closure. Rejected.
- No config switch: pure-display features arguably need none — but ellipsis discards visible information (unlike a color), so an escape hatch is honest. Accepted as on/off, header-scoped.

## Consequences

- Header rendering becomes width-aware (the preview-task path, same as the error frame) instead of width-blind setText.
- Tests pin: ellipsis shape (middle cut, suffix pinned), expand toggle, off-means-full.
