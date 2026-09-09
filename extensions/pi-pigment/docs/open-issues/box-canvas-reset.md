# Open issue: pi-tui paints the frame canvas once per line — inline full resets expose the terminal default

## The contract

pi-tui's `Box.applyBackgroundToLine` applies the frame background as a **single line-level wrap**: `bgFn(line + padding)` — one opening escape at the line start, one closing escape at the end. It does NOT re-apply the background after inner escapes (the `injectBg` primitive in pi-pigment does that for the Text hosts we wrap ourselves; the Box that frames every tool result does not).

Consequence: any **full reset (`\x1b[0m`) inside a tool line** turns off the canvas from that cell onward — the rest of the line (including the Box's own padding) renders on the terminal's default background.

## History in pi-pigment

- `tool-ls` documented the rule first: its `fgCode` rows close with the channel-scoped `FG_DEFAULT` (`\x1b[39m`) — "a full `\x1b[0m` would kill pi core's frame canvas and whiten the row's tail padding".
- `tool-grep` / `tool-find` were still closing with a full `RESET`, and the grep/find emphasis wrap (`pattern-emphasis.ts`) emitted a full reset **mid-line after every match** — everything from the first match onward exposed the terminal default. Fixed in the channel-scoped-closes commit: the emphasis wrap closes bold-only (`\x1b[22m`) and re-opens the span fg; grep/find line tails close with `FG_DEFAULT`.
- The header summary chips close with a bare `\x1b[0m` — safe there because the header Text carries pi-pigment's own `injectBg` fn, which re-opens the live background after every reset before the canvas can be lost.

## Why this belongs here (upstream observation)

The hazard is structural, not cosmetic: pi-core's Box gives child Text lines a single defensive background wrap, and **any** tool renderer (ours or upstream's) that emits a full reset mid-line breaks the frame's visual continuity. Upstream cannot fix tool-by-tool; the Box-level `bgFn` could re-apply the background after inner resets (what `injectBg` does), which would make full resets harmless everywhere. Until then, pi-pigment's rule: channel-scoped closes (`\x1b[39m`, `\x1b[22m`, …) in every Box-hosted line; full resets only where an injection fn guards them.
