# 0005 — Rendering-only: pi-pigment never implements or activates tools

Status: **Accepted**

## Context

pi-pigment began as a renderer for pi's built-in tool output (syntax-highlighted
diffs, shell-grammar commands, grep hit emphasis). Successive comparison
rounds — against pi-pretty in particular — kept surfacing proposals that
would grow it past that identity:

- **Force-activate dormant tools.** pi's default active set is
  `read/bash/edit/write` only; `grep`/`find`/`ls`/`powershell` are
  registered but dormant until the user (or a tool extension) activates
  them. A proposal to call `setActiveTools` for our wrapped names was
  rejected mid-implementation: it changes the agent's capability surface —
  which tools the model sees and calls — which is the user's call, not a
  renderer's.
- **Bundle a search engine.** pi-pretty bundles `@ff-labs/fff-node` (a
  ~13 MB native binary per platform) and implements its own ffgrep/fffind
  on top. The proposal to do the same was rejected: it makes pi-pigment a
  tool implementation with rendering attached, inverts its reason to
  exist, and imports the maintenance burden of mirroring another
  project's model-facing output format.
- **Wrap another extension's tools.** Structurally impossible under the
  current extension API anyway (verified empirically): same-name
  registration is first-wins, and the API exposes no way to obtain
  another extension's tool definition — so the wrapper would have to
  register before the tool it wraps exists. This is an upstream API gap,
  not a reason to work around it here.

## Decision

**pi-pigment is a decoration layer.** Its entire tool-facing surface is
registering same-name wrappers over the SDK's built-in tool definitions —
delegating execute verbatim and replacing only renderCall / renderResult.
It does not:

- implement tools (no own execute logic beyond delegating to the wrapped
  definition, no engine dependencies),
- activate tools (no `setActiveTools` — the active set belongs to the
  user and to tool extensions),
- bundle capabilities that belong to tools (search indexes, file
  watchers, anything the model would call).

Registered-but-dormant wrappers are the intended steady state: whatever
the environment activates, pi-pigment decorates; what nobody activates,
idles harmlessly.

The corollary already in force: **yield, don't crowd.** When another
extension's tool vocabulary is present (pi-fff's `ffgrep`/`fffind`),
pi-pigment does not register same-name wrappers that would displace it —
first-wins registration from an earlier-loaded renderer would silently
swap another extension's semantics for the built-ins'.

### Amendment: what "delegating execute verbatim" means in practice

The wrappers re-enter execute only to stash their own render-time payload
(write's diff), so the exact discipline is worth writing down:

- **The model-facing result is untouchable** — content, isError, every
  field the agent consumes passes through unchanged.
- **A wrapper appends nothing it can derive at render time.** The factory
  adds NO key at all: the execution timing that drives the `Took` footer
  lives in the render state (pi's own shell-renderer clock), so a
  pi-pigment session carries exactly the tool's own payload — see the
  session-footprint note below.
- **`result.details` keeps the SDK's own shape.** Wrappers may APPEND
  keys; they may not drop or retype the SDK's fields. Sessions are the
  shared boundary: a pi-pigment-created session resumed WITHOUT pi-pigment
  renders through the SDK's native renderers, which read their own
  details fields (`diff`, `patch`, `firstChangedLine`) — a renderer that
  rewrites details in execute breaks that resume path. (Added after the
  edit wrapper replaced the SDK's details with a parsed payload, breaking
  native rendering of pi-pigment-created sessions; parsing moved to
  renderResult.)
- **Documented exception — write**: the SDK's own write execute stashes
  `details: undefined`, so the write wrapper's diff payload (old/new
  content for the split preview) is the only thing details has ever
  carried there. It is an addition to an empty slot, not a replacement of
  native fields.

## Consequences

- A request for "fff search semantics with pi-pigment rendering" is an
  upstream feature (a render-decoration API: full `getToolDefinition`,
  or a renderCall/renderResult override registration) — not something
  pi-pigment implements locally. File the issue upstream if it matters;
  don't bundle engines here.
- Future comparisons with pi-pretty (or similar multi-tool extensions)
  should score feature gaps against this boundary: features below it
  (rendering polish, collapse affordances, timing footers) are in scope;
  features above it (tool implementations, activation changes, bundled
  engines) are out — even when the comparison makes them look like gaps.
- The extension stays dependency-light: Shiki (highlighting),
  @aliou/sh (shell-AST injection), diff. New dependencies that add
  capabilities rather than rendering fidelity are presumptively rejected.
- **Duration is render state, never session state.** `Took`/`Elapsed`
  footers read the clock pi's shell renderer keeps in the render state
  (`startedAt` armed in renderCall, `endedAt` fixed by the settled
  renderResult). Nothing about timing is persisted: a session resumed
  without pi-pigment, or replayed into it, shows no duration — matching
  pi's native renderers, whose timing display is live-only by the same
  mechanism.
