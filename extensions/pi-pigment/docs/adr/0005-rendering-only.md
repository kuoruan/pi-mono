# 0005 — Rendering-only: pi-pigment never implements or activates tools

Status: **Accepted**

## Context

pi-pigment began as a renderer for pi's built-in tool output (syntax-highlighted diffs, shell-grammar commands, grep hit emphasis). Successive comparison rounds — against pi-pretty in particular — kept surfacing proposals that would grow it past that identity:

- **Force-activate dormant tools.** pi's default active set is `read/bash/edit/write` only; `grep`/`find`/`ls`/`powershell` are registered but dormant until the user (or a tool extension) activates them. A proposal to call `setActiveTools` for our wrapped names was rejected mid-implementation: it changes the agent's capability surface — which tools the model sees and calls — which is the user's call, not a renderer's.
- **Bundle a search engine.** pi-pretty bundles `@ff-labs/fff-node` (a ~13 MB native binary per platform) and implements its own ffgrep/fffind on top. The proposal to do the same was rejected: it makes pi-pigment a tool implementation with rendering attached, inverts its reason to exist, and imports the maintenance burden of mirroring another project's model-facing output format.
- **Own the built-in names.** For years the only way to change how a tool rendered was to re-register the same name (pi documents it under "Overriding Built-in Tools"). pi-pigment did exactly that: same-name registrations over the SDK's built-in definitions, delegating execute verbatim and replacing only `renderCall` / `renderResult`. Registration is first-wins across extensions, so a later extension that wanted the name was silently dropped.

## Decision

**pi-pigment is a decoration layer.** Since `@earendil-works/pi-coding-agent` 1.0.1 it renders through `pi.registerToolRenderer`, and it does not:

- implement tools (no execute logic, no engine dependencies),
- register tools (no name occupancy — execution, the model-facing result, and the name always stay pi's own),
- activate tools (no `setActiveTools` — the active set belongs to the user and to tool extensions),
- expose a rendering API for others to borrow (see "The renderer resolver" below).

It registers **one renderer resolver** for the eight built-in names (`write`, `edit`, `bash`, `powershell`, `grep`, `ls`, `find`, `read`). Whatever the environment activates, pi-pigment decorates; what nobody activates, idles harmlessly.

### Renderer-only, not tool ownership

`ToolRendererResolver` receives a tool name and a `next()` that returns the renderers the remaining resolvers, then the registered tool, would use; returning a value overrides `renderShell`/`renderCall`/`renderResult` and nothing else. This is the renderer-only override the extension API had lacked — it closes upstream issues [#3541](https://github.com/earendil-works/pi/issues/3541) and [#6700](https://github.com/earendil-works/pi/issues/6700) (both once declined as "not planned"), and makes same-name registration unnecessary. `registerToolRenderer` is why the peer floor is `>=1.0.1`.

The resolver reads the live registry (`getAllTools()`) per call, so — unlike the old `session_start` snapshot — it sees names registered in any extension's `session_start`, including extensions loaded after pi-pigment.

### The renderer resolver contract

1. **Unknown name** → `next()`.
2. **A name another extension owns** (`sourceInfo.source !== "builtin"`) → `next()`. The old reason — first-wins displacement — is gone; the standing reason is correctness: our renderers parse the _built-in_ tool's arguments and result details, so painting them over a neighbor's differently-shaped tool would render wrong.
3. **pi-fff present** (`/fff-mode` command, or its grep/find vocabulary) → `next()` for `grep`/`find`.
4. **No session kit yet** (before the first `session_start`, or a failed build) → `next()` (fail-safe to pi's own rendering).
5. **Name in `disabledTools`** → `next()`.
6. Otherwise build the renderer triple over `next()`.

Rules 1–5 live in one function, `gate.shouldYield`, read by both the resolver and the write-details channel, so the two can never disagree about whether a name is ours. The no-kit fail-safe (4) is evaluated first at the call site (it holds no policy), and every yield rule returns `next()`, so their order is stated for reasoning, not observable — the outcome is identical whichever gate fires.

The yield can only recognize neighbors that **register a tool name** — a neighbor that registers only a renderer is invisible to `getAllTools()`. It is also order-independent now, since the registry is read per call rather than snapshotted at startup.

### The write exception

The SDK's write tool stashes `details: undefined`, so its old/new diff has to come from somewhere. pi-pigment captures it through the two execution hooks pi exposes — `tool_call` (read the pre-write file, keyed by `toolCallId`) and `tool_result` (emit `{ details }`), since `tool_execution_end` is read-only. The details are produced **only when the file that landed byte-equals the content the call supplied**; a sibling write, a changed argument, an aborted call, or a blocked one yields no diff rather than a wrong one. Execution still belongs entirely to pi's write tool.

`result.details` keeps the SDK's own shape: the channel _appends_ the write payload to the empty slot the SDK leaves. Edit does not touch details at all — it parses the SDK's own `patch` lazily at render time, so pi-pigment-created sessions render identically under the native renderer when resumed without pi-pigment.

## Consequences

- A request for "fff search semantics with pi-pigment rendering" is no longer blocked by the API: a neighbor owns its own name, pi-pigment yields it, and both extensions run. Composing _pigment's_ renderers onto a foreign tool is not supported (pi-pigment exposes no rendering API); features below the boundary (rendering polish, collapse affordances, timing footers) are in scope, features above it (tool implementations, activation changes, bundled engines) are out.
- The extension stays dependency-light: Shiki (highlighting), @aliou/sh (shell-AST injection), diff. New dependencies that add capabilities rather than rendering fidelity are presumptively rejected.
- **The shell settings are pi's again.** The old same-name registration had to rebuild bash through the SDK factory with the trust-gated `shellCommandPrefix`/`shellPath` or a configured shell would silently stop applying to the executing command. Registering nothing removes that footgun entirely.
- **Duration prefers pi's recorded execution time.** The `Took`/`Elapsed` footers read `ctx.durationMs` when the host supplies it (pi 1.1.0 live frames, and replayed rows whose result carried it), falling back to the render-state clock (`startedAt`/`endedAt`) on 1.0.1, on a partial frame, and on HTML export — the places `durationMs` is undefined. Nothing _fabricated_ is persisted; this is pi's own recorded duration, so a replayed row on 1.1.0 may now show a footer where it previously showed none.
- **Both seams are guarded.** pi's `resolveToolRenderers` and `emitToolCall` have no try/catch of their own, so a fault escaping either one would reach the TUI as an unhandled exception — or, on the execution hook, be reframed as "Extension failed, blocking execution". The resolver therefore falls back to `next()` when our own triple fails to build, and the write-details channel swallows a failed `tool_call` read and drops its stash. A rendering-side bug degrades the render; it never breaks pi's rendering and never blocks the model's execution.

## History

- **The occupied slot (retired).** Until the resolver migration, pi-pigment re-registered the eight names and documented the cost: first-wins dropped later extensions silently, `getAllTools()` exposed no execute, and there was no unregister. All of that is moot now — kept here only to explain why the old design existed.
- **`pi-pigment/render-kit` (removed).** The borrowing API (import channel + `globalThis` publication) was ADR 0005's "lend": the winner of a name could install pi-pigment's renderers on its own tool definition. It existed solely because pi had no renderer-only override; with `registerToolRenderer` it is redundant, and it was removed along with its write-lend contract.
