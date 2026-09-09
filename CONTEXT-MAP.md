# Context Map

## Contexts

- [pi-mono](./CONTEXT.md) — the workspace itself: packages, catalog, changesets, shared toolchain
- [pi-permission-ai-guard](./extensions/pi-permission-ai-guard/CONTEXT.md) — a Pi extension that reviews permission asks with a light model
- [pi-pigment](./extensions/pi-pigment/CONTEXT.md) — a Pi theme provider and tool-output renderer: the Shiki bundle as registered pi themes (pick one in /theme — the whole pi follows), plus Shiki-highlighted write/edit diffs, bash commands with heredoc injection, grep hits, and type-colored ls

## Relationships

- **pi-mono → pi-permission-ai-guard**: The workspace provides the toolchain
  (oxlint, oxfmt, vitest projects mode, tsconfig, catalog) and release
  infrastructure (changesets + npm trusted publishing). The ai-guard package
  inherits shared dependency versions via `catalog:` and follows the
  workspace's lint/format/test conventions.
- **pi-permission-ai-guard → upstream Pi**: The extension consumes
  `@earendil-works/pi-coding-agent` (ExtensionAPI, ModelRegistry) and
  `@gotgenes/pi-permission-system` (Authorizer chain, AuthorizerLog) as
  immutable external seams. It registers an `"ai-guard"` authorizer link.
- **pi-mono → pi-pigment**: Same workspace inheritance: shared toolchain,
  catalog dev dependencies, and changeset-driven release. Source-shipped
  (no build step), like pi-permission-ai-guard.
- **pi-pigment → upstream Pi**: The extension consumes
  `@earendil-works/pi-coding-agent` (ExtensionAPI, SDK tool factories) and
  `@earendil-works/pi-tui` (Text component) as immutable external seams. It
  re-registers the built-in `write`, `edit`, `bash`, `grep`, and `ls` tools
  as render-only wrappers (execution delegates verbatim).
