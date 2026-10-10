---
"pi-pigment": minor
---

pi-pigment no longer registers any tool: it contributes a single `registerToolRenderer` resolver for the eight built-in names (`write`, `edit`, `bash`, `powershell`, `grep`, `ls`, `find`, `read`), so execution, the model-facing result, and name ownership stay pi's own. This ends the same-name registration that silently shadowed a later extension's tool, and drops the shell-settings rebuild (`commandPrefix`/`shellPath` flow through pi's own bash tool untouched). The write diff — which the SDK's write tool does not carry — is captured through the `tool_call`/`tool_result` hooks and emitted only when the file that landed byte-equals the supplied content.

Breaking for consumers:

- The public `pi-pigment/render-kit` entry (import module and `globalThis` publication) is removed; it existed only because pi lacked a renderer-only override.
- Requires `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` >= 1.0.1 < 2.0.0 (previously >= 0.85.0) — `registerToolRenderer` landed in 1.0.1.
- Replayed rows may now show a `Took` footer on pi 1.1.0+ (pi's recorded execution time; the render-state clock remains the fallback on 1.0.1, HTML export, and partial frames).
