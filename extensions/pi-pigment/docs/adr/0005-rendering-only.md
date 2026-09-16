# 0005 — Rendering-only: pi-pigment never implements or activates tools

Status: **Accepted**

## Context

pi-pigment began as a renderer for pi's built-in tool output (syntax-highlighted diffs, shell-grammar commands, grep hit emphasis). Successive comparison rounds — against pi-pretty in particular — kept surfacing proposals that would grow it past that identity:

- **Force-activate dormant tools.** pi's default active set is `read/bash/edit/write` only; `grep`/`find`/`ls`/`powershell` are registered but dormant until the user (or a tool extension) activates them. A proposal to call `setActiveTools` for our wrapped names was rejected mid-implementation: it changes the agent's capability surface — which tools the model sees and calls — which is the user's call, not a renderer's.
- **Bundle a search engine.** pi-pretty bundles `@ff-labs/fff-node` (a ~13 MB native binary per platform) and implements its own ffgrep/fffind on top. The proposal to do the same was rejected: it makes pi-pigment a tool implementation with rendering attached, inverts its reason to exist, and imports the maintenance burden of mirroring another project's model-facing output format.
- **Wrap another extension's tools.** Structurally impossible under the current extension API anyway (verified empirically): same-name registration is first-wins, and the API exposes no way to obtain another extension's tool definition — so the wrapper would have to register before the tool it wraps exists. This is an upstream API gap, not a reason to work around it here.

## Decision

**pi-pigment is a decoration layer.** Its entire tool-facing surface is registering same-name wrappers over the SDK's built-in tool definitions — delegating execute verbatim and replacing only renderCall / renderResult. It does not:

- implement tools (no own execute logic beyond delegating to the wrapped definition, no engine dependencies),
- activate tools (no `setActiveTools` — the active set belongs to the user and to tool extensions),
- bundle capabilities that belong to tools (search indexes, file watchers, anything the model would call).

Registered-but-dormant wrappers are the intended steady state: whatever the environment activates, pi-pigment decorates; what nobody activates, idles harmlessly.

The corollary already in force: **yield, don't crowd.** When another extension's tool vocabulary is present (pi-fff's `ffgrep`/`fffind`), pi-pigment does not register same-name wrappers that would displace it — first-wins registration from an earlier-loaded renderer would silently swap another extension's semantics for the built-ins'. The rule is scoped to the presence probes that exist, not a general priority mechanism (see "The occupied slot" below).

### Amendment: what "delegating execute verbatim" means in practice

The wrappers re-enter execute only to stash their own render-time payload (write's diff), so the exact discipline is worth writing down:

- **The model-facing result is untouchable** — content, isError, every field the agent consumes passes through unchanged.
- **A wrapper appends nothing it can derive at render time.** The factory adds NO key at all: the execution timing that drives the `Took` footer lives in the render state (pi's own shell-renderer clock), so a pi-pigment session carries exactly the tool's own payload — see the session-footprint note below.
- **`result.details` keeps the SDK's own shape.** Wrappers may APPEND keys; they may not drop or retype the SDK's fields. Sessions are the shared boundary: a pi-pigment-created session resumed WITHOUT pi-pigment renders through the SDK's native renderers, which read their own details fields (`diff`, `patch`, `firstChangedLine`) — a renderer that rewrites details in execute breaks that resume path. (Added after the edit wrapper replaced the SDK's details with a parsed payload, breaking native rendering of pi-pigment-created sessions; parsing moved to renderResult.)
- **Documented exception — write**: the SDK's own write execute stashes `details: undefined`, so the write wrapper's diff payload (old/new content for the split preview) is the only thing details has ever carried there. It is an addition to an empty slot, not a replacement of native fields.

### The occupied slot, and why it stays

Same-name registration is the API's only expression of a rendering override: pi documents it under "Overriding Built-in Tools", and pi's own shipped `built-in-tool-renderer.ts` example ("Custom rendering for built-in tools without changing their behavior") is built exactly this way — re-register the name, delegate `execute`. There is no renderer-only channel to migrate to: `ExtensionAPI`'s rendering registrations are `registerMessageRenderer` and `registerEntryRenderer`, both keyed by an extension's own custom type, never by a tool name.

The cost is that each wrapper occupies the name. Registration is first-wins across extensions, and extension tools are then laid over the built-ins, so a later extension that wants to own `bash` is silently dropped. 0.85.1 also emits no warning for that, although `docs/extensions.md` claims interactive mode warns (verified against the shipped `dist`, where the only override diagnostics are for shortcuts and commands).

Upstream has been asked for a renderer-only API repeatedly and declined every time, so this is not a gap we can close locally:

- [#3541](https://github.com/earendil-works/pi/issues/3541) render-only tool override API (e.g. `pi.registerToolRenderer`) — "sorry, not planned atm."
- [#6700](https://github.com/earendil-works/pi/issues/6700) rendering override without taking over execution — "this will change in pi server mode. not planed for old pi."
- [#3553](https://github.com/earendil-works/pi/issues/3553) silent built-in override — "works as intended."
- #7800, #8347, #7615 (decorating an already-registered tool, the same `pi.registerToolRenderer` proposal, override fragility) — auto-closed, no reply.

The companion gap: no public API returns a built-in tool's own definition either. `getAllTools()` yields `ToolInfo` (name, parameters, description) with no `execute` (#7800, auto-closed), so a renderer that wants to decorate a tool it does not itself own has to rebuild the definition through the SDK factories (`createBashToolDefinition`, and siblings) — and re-apply by hand the options pi baked in under its own gates (bash's trust-gated `shellCommandPrefix`/`shellPath`; see the tool-wrapper entry in [CONTEXT.md](../../CONTEXT.md)). Live with the factories until upstream exposes the definition itself; do not re-implement execution to avoid them.

The yield rule above is therefore scoped to the one case where a cheap, order-safe presence probe exists: pi-fff's `/fff-mode` command registers at module load, before any `session_start`, so it is visible no matter which extension loads first (see FFF yield in [CONTEXT.md](../../CONTEXT.md)). A general "yield to whoever registers the name" is not implementable against this API — there is no unregister, nothing exposes a tool that registers after us, and deferring our own registration to a later event only trades the occupancy for a registry refresh that ACTIVATES the newly seen names, which would surface dormant `grep`/`find`/`ls`/`powershell` to the model and break this ADR's own boundary. Track a render-decoration layer upstream; do not work around its absence by giving up the rendering.

### Addendum — generic yield on visible occupancy

Part of that paragraph aged out: the general yield IS implementable for the half the registry exposes. `getAllTools()` returns each entry's `sourceInfo`, so at our `session_start` we can see every name another extension (or an SDK-passed custom tool) already claimed and skip our wrapper for it — the `claimedByOther` check in `src/extension.ts`, with the `registeredByUs` guard so a resume/fork re-fire does not yield to our own first-fire wrappers. Each skip reports once through the issue channel (the FFF path stays silent: it is the documented default, not a surprise).

What stays true: no unregister, and no visibility into tools that register after our `session_start` fires. A neighbor that loads after us loses the name to us (pi merges by load order, not registration time) no matter what its own `session_start` does — our wrapper stays live and we emit no notice, because from our snapshot nothing was taken. The loader logs a name conflict for the dropped registration; documented escape hatches for that case: the neighbor registers in its factory (visible to us, so we yield), borrows our renderers through the render kit (both render), or the user lists the name in `disabledTools`. Do NOT "fix" the order gap by deferring to a later event: the later refresh would activate dormant tools and break this ADR's boundary — the same reason the original paragraph gave.

## Consequences

- A request for "fff search semantics with pi-pigment rendering" is an upstream feature (a render-decoration API: full `getToolDefinition`, or a renderCall/renderResult override registration) — not something pi-pigment implements locally. File the issue upstream if it matters; don't bundle engines here.
- Future comparisons with pi-pretty (or similar multi-tool extensions) should score feature gaps against this boundary: features below it (rendering polish, collapse affordances, timing footers) are in scope; features above it (tool implementations, activation changes, bundled engines) are out — even when the comparison makes them look like gaps.
- The extension stays dependency-light: Shiki (highlighting), @aliou/sh (shell-AST injection), diff. New dependencies that add capabilities rather than rendering fidelity are presumptively rejected.
- **Duration is render state, never session state.** `Took`/`Elapsed` footers read the clock pi's shell renderer keeps in the render state (`startedAt` armed in renderCall, `endedAt` fixed by the settled renderResult). Nothing about timing is persisted: a session resumed without pi-pigment, or replayed into it, shows no duration — matching pi's native renderers, whose timing display is live-only by the same mechanism.
