---
"pi-pigment": patch
---

Styled rows carrying OSC-8 file hyperlinks no longer corrupt the link or the row width: the background re-injection scanner and the cell walk now treat OSC sequences as whole units (an "m" inside a URL no longer ends an SGR scan), which also fixes the crash pi's TUI raises when a resumed session renders an over-wide header row.
