# pi-mono

A pnpm monorepo for Pi Agent extension packages, each independently versioned and published to npm. This file pins down the workspace's vocabulary; per-extension language lives in each package's own glossary.

## Language

**Extension**:
A package that plugs into the Pi Agent runtime through `ExtensionAPI`, adding hooks, authorizers, or tools. Lives under `extensions/`.
_Avoid_: plugin, add-on, module

**Package**:
A single independently versioned npm unit in the workspace. Every extension is a package; the repo may host other package kinds later.
_Avoid_: workspace member, sub-project

**Workspace**:
The pnpm workspace root. All packages share one `pnpm-lock.yaml` and one toolchain (oxlint, oxfmt, vitest, tsconfig); package code lives under `extensions/`, cross-package infrastructure at the root.
_Avoid_: monorepo root

**Catalog**:
The `catalog:` protocol in `pnpm-workspace.yaml`. Pins shared dependency versions once at the workspace level; packages declaring `"catalog:"` inherit them.
_Avoid_: dependency map, version table

**Changeset**:
A markdown record under `.changeset/` describing a package change (semver bump + summary). Accumulated changesets drive the automated Version Packages PR and the npm publish.
_Avoid_: changelog entry
