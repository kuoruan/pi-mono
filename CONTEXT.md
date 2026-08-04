# pi-mono

A pnpm monorepo for Pi Agent extension packages. Each package is
independently versioned and published to npm.

## Language

**Extension**:
A package that plugs into the Pi Agent runtime via `ExtensionAPI`, adding
hooks, authorizers, or tools. Lives under `extensions/`.
_Avoid_: plugin, add-on, module (use "package" for the generic npm unit)

**Package**:
A single independently versioned npm unit in the workspace. An extension is
a package; the repo may later host other package kinds.
_Avoid_: workspace member, sub-project

**Workspace**:
The pnpm workspace root. All packages share a single `pnpm-lock.yaml` and a
shared toolchain (oxlint, oxfmt, vitest, tsconfig). Package code lives under
`extensions/`; cross-package infrastructure (CI, release, formatting,
linting) lives at the root.
_Avoid_: monorepo root (say "workspace" when referring to the pnpm structure)

**Catalog**:
The `catalog:` protocol in `pnpm-workspace.yaml`. Pins shared dependency
versions once at the workspace level; packages declare `"catalog:"` in their
`package.json` to inherit. Prevents version drift across packages without
moving dependency declarations off the packages that own them.

**Changeset**:
A markdown record under `.changeset/` describing a package change (semver
bump + summary). Accumulated changesets drive the automated Version Packages
PR and subsequent npm publish.
_Avoid_: changelog entry (a changeset becomes a changelog entry at release time)
