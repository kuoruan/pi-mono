# Context Map

## Contexts

- [pi-mono](./CONTEXT.md) — the workspace itself: packages, catalog, changesets, shared toolchain
- [pi-permission-ai-guard](./extensions/pi-permission-ai-guard/CONTEXT.md) — a Pi extension that reviews permission asks with a light model

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
