# pi-mono

A pnpm monorepo for PI Agent extension packages.

## Structure

```
.
├── extensions/             # Extension packages (one per directory)
│   └── pi-permission-ai-guard/   # AI model-based permission reviewer
├── .changeset/             # Release change records (Changesets)
├── .github/workflows/      # CI (lint/type-check/test) + release (changesets → npm)
├── .husky/                 # Git hooks (pre-commit: lint-staged)
├── .lintstagedrc.json      # lint-staged config (oxlint --fix on staged files)
├── .oxfmtrc.json           # oxfmt formatter config
├── .oxlintrc.json          # oxlint linter config (rules + overrides)
├── .node-version           # Node.js version pin (22)
├── .npmrc                  # pnpm settings (auto-install-peers, peer-dependency strictness)
├── CONTEXT.md              # Workspace-level domain language
├── CONTEXT-MAP.md          # Index of contexts in the repo
├── package.json            # Workspace root (private, devDependencies, scripts)
├── pnpm-workspace.yaml     # Workspace packages + catalog (shared dep versions)
└── vitest.config.ts        # Root vitest projects-mode config (runs all packages)
```

## Toolchain

| Tool                | Role                                                                    | Config                                              |
| ------------------- | ----------------------------------------------------------------------- | --------------------------------------------------- |
| pnpm 10             | Workspace + dependency management                                       | `pnpm-workspace.yaml`, `packageManager` field       |
| TypeScript 7        | Type-checking (per-package `tsconfig.json`, extends `@tsconfig/node22`) | `catalog:` version                                  |
| oxlint              | Linting                                                                 | `.oxlintrc.json`                                    |
| oxfmt               | Code formatting                                                         | `.oxfmtrc.json`                                     |
| Vitest 4            | Unit testing (projects mode — one root config runs all packages)        | `vitest.config.ts` + per-package `vitest.config.ts` |
| Changesets          | Per-package versioning + changelog                                      | `.changeset/config.json`                            |
| Husky + lint-staged | Pre-commit hook runs `oxlint --fix` on staged files                     | `.husky/`, `.lintstagedrc.json`                     |

## Shared dependency versions

Shared dependency versions are pinned once in `pnpm-workspace.yaml` under `catalog:`. Packages reference them as `"catalog:"` in their `package.json` — the version is resolved from the workspace catalog, preventing drift across packages without moving dependency declarations off the packages that own them.

## Release

Releases use [Changesets](.changeset/README.md) for independent per-package versioning.
