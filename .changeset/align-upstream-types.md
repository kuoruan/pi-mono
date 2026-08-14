---
"pi-permission-ai-guard": patch
---

Align `ModelCallAuth` with upstream pi-ai types and bump dev/runtime deps.

- `ModelCallAuth` is now `Pick<SimpleStreamOptions, "apiKey" | "headers">`,
  replacing a hand-written `Record<string, string>` whose header type was
  too narrow (pi-ai 0.84 widened provider headers to `string | null`). This
  fixes a type error introduced by the `@earendil-works/pi-ai` 0.83 → 0.84
  upgrade and keeps the auth type auto-aligned with future upstream changes.
- Bump dev dependencies to latest: `@earendil-works/pi-ai` and
  `@earendil-works/pi-coding-agent` 0.83 → 0.84.1,
  `@gotgenes/pi-permission-system` 24.0.0 → 25.2.0 (adds consulted-chain-link
  review-log recording and fixes a false "unregistered link" report for
  delegated subagent chains), `oxfmt` 0.61 → 0.63, `oxlint` 1.77 → 1.78,
  `memfs` 4.66 → 4.68. No public API or runtime behavior change.
