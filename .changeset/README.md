# Changesets

This repo uses [Changesets](https://github.com/changesets/changesets) to manage versioning and releases.

## Adding a change record

When you make a change under `extensions/*` that should be released, run:

```bash
pnpm changeset
```

Follow the prompts to select:

- **Changed packages** — which packages are affected
- **Version bump type** — `major` / `minor` / `patch`
- **Change summary** — written to CHANGELOG.md

This generates a Markdown file under `.changeset/` (e.g. `spicy-pandas-jump.md`) describing the change.

## Release flow

This repo uses the [Changesets GitHub Action v2](https://github.com/changesets/action)
with the **sub-action pattern** (`select-mode` → `version` | `publish`), which
is the official 2026 best practice for Trusted Publishing.

### `.github/workflows/release.yml` (triggered on `push: master`)

The workflow has three jobs, gated by `select-mode`:

1. **`select-mode`** — inspects the changeset state and outputs `mode`:
   `"version"` (pending changesets exist) or `"publish"` (Version PR merged,
   packages ready to publish).
2. **`version`** (when `mode == "version"`) — runs `changeset version` and
   opens/updates a **"Version Packages"** PR. Does NOT publish.
3. **`publish`** (when `mode == "publish"`) — runs `changeset publish` via
   `changesets/action/publish@v2` with npm Trusted Publishing (OIDC) and
   provenance. `id-token: write` is scoped to this job only.

This design ensures `pnpm publish` only runs when `select-mode` detects a
publish state. Note that for an initial unpublished package,
`select-mode` routes to `publish` on every push to `master` until the first
release lands — this is expected, not a bug.

## Independent per-package versions

This repo uses an **independent versioning** strategy: each package maintains its own `version` and is bumped independently based on its own changesets, without forcing a unified version across packages.

## AI agent release contract

This section defines the release protocol for AI agents (and human contributors) working in this repo. The goal: keep release decisions explicit and reviewable, never dependent on commit-message conventions.

### When to create a changeset

Create a changeset (`pnpm changeset`) when a change modifies the **public release surface** of a publishable package:

- `extensions/*/src/**` — runtime behavior of an extension
- `extensions/*/package.json` — `exports`, `dependencies`, `peerDependencies`, `files`, new/removed scripts that affect consumers
- `extensions/*/schemas/**`, `extensions/*/config/**` — shipped config or schema files
- Any other publishable surface

Write the change summary as a **user-facing English sentence** describing what changed for consumers, not an implementation detail. Example: `Add cache size config option for the AI guard.` — not `refactored VerdictCache constructor`.

### When a changeset is NOT required

Do not create a changeset for changes that don't affect a published package's public surface:

- Documentation (`*.md`, README updates)
- CI / workflow / tooling (`.github/`, `.oxlintrc.json`, `.oxfmtrc.json`, root `package.json` scripts)
- Formatting, lint fixes, test-only changes
- Workspace infrastructure (pnpm-workspace.yaml, catalog versions, tsconfig)
- The `.changeset/` directory itself

### Commands an agent MUST NOT run

AI agents must not execute any release-publishing command directly. These run only in CI on a protected `master` branch:

- `pnpm changeset version` — consumes changesets and bumps versions (CI opens the Version PR)
- `pnpm changeset publish` / `pnpm publish -r` — publishes to npm
- `git tag`, `git push --tags` — release tags are created by CI
- Creating or merging GitHub Releases — done by CI after publish

An agent's release-related scope is limited to: creating `.changeset/*.md` files alongside code changes. Everything else is CI-driven.

### Release flow recap (agent perspective)

1. Agent edits code under `extensions/*` and, if the public surface changed, runs `pnpm changeset` and commits the generated file in the same PR.
2. PR CI runs `pnpm lint`, `pnpm fmt:check`, `pnpm check`, `pnpm test`.
3. PR merges to `master`. `release.yml` runs `select-mode` → `version` and opens/updates the single **Version Packages** PR.
4. A human reviews the Version PR (versions, CHANGELOGs, affected packages) and merges it.
5. `release.yml` runs `select-mode` → `publish` and publishes the new versions to npm with Trusted Publishing (OIDC) + provenance.
