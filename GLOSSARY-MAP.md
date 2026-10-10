# Glossary Map

## Contexts

- [pi-mono](./GLOSSARY.md) — the workspace itself: packages, catalog, changesets, shared toolchain
- [pi-permission-ai-guard](./extensions/pi-permission-ai-guard/GLOSSARY.md) — a Pi extension that reviews permission asks with a light model
- [pi-pigment](./extensions/pi-pigment/GLOSSARY.md) — a Pi theme provider and tool-output renderer

## Relationships

- **pi-mono → pi-permission-ai-guard**: The workspace provides the toolchain (oxlint, oxfmt, vitest projects mode, tsconfig, catalog) and release infrastructure (changesets + npm trusted publishing). The package inherits shared dependency versions via `catalog:` and follows the workspace's lint/format/test conventions.
- **pi-permission-ai-guard → upstream Pi**: Consumes `@earendil-works/pi-coding-agent` (ExtensionAPI, ModelRegistry) and `@gotgenes/pi-permission-system` (Authorizer chain, AuthorizerLog) as immutable external seams. Registers an `"ai-guard"` authorizer link.
- **pi-mono → pi-pigment**: Same workspace inheritance: shared toolchain, catalog dev dependencies, and changeset-driven release. Source-shipped, no build step.
- **pi-pigment → upstream Pi**: Consumes `@earendil-works/pi-coding-agent` (ExtensionAPI, `registerToolRenderer`) and `@earendil-works/pi-tui` (Text component) as immutable external seams. Registers one renderer resolver that supplies the built-in `write`, `edit`, `bash`, `powershell`, `grep`, `ls`, `find`, and `read` tools' render-only slots — execution stays pi's own.
