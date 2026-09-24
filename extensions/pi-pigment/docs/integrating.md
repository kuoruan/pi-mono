# Integrating with pi-pigment

How a third-party extension borrows pi-pigment's rendering — and what pi-pigment borrows back.

Three integration surfaces, in decreasing order of commitment:

| Surface                                                                | What you get                                                 | Cost                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| [Borrow the renderers](#borrow-the-renderers-render-kit)               | pi-pigment's tool/message rendering on YOUR tool definitions | a dependency on `pi-pigment` (or none, see B)            |
| [Theme-level integration](#theme-level-integration)                    | your users get full-precision rendering under your themes    | nothing — the default behavior                           |
| [Coexistence rules](#coexistence-first-wins-and-how-pi-pigment-yields) | your tools survive next to pi-pigment                        | nothing — but read it before registering `bash`/`grep`/… |

The contract is pinned by tests (`tests/render/kit.test.ts`): the published surface is asserted against the module exports, and a borrowed render is asserted byte-identical to pi-pigment's own.

## Why borrowing exists at all

pi's extension API has no renderer-only override: the only way to change how a tool renders is to register a same-name tool definition, and registration is **first-wins across extensions** (silently — 0.85.x emits no warning, see [ADR 0005](adr/0005-rendering-only.md)). pi-pigment renders the built-ins by occupying their names.

So if YOUR extension also registers `bash`, the two extensions race: whoever loads first wins, and the loser is dropped without a trace. pi-pigment's answer is **yield + lend**: it yields names it did not win, and lends its renderers to whoever won them. You keep your `execute`; pi-pigment keeps the pixels.

## Borrow the renderers (`render-kit`)

```bash
pi install npm:pi-pigment   # users install it once; or add it to your own package.json
```

```ts
import { createRenderKit } from "pi-pigment/render-kit";
```

`createRenderKit({ cwd, agentDir?, indicatorStyle?, reportIssue? })` resolves the config layers and the theme selection **once per session** and returns a kit (`{ tools, session, hasTool, decorate }`). `decorate(definition)` installs pi-pigment's renderers on your definition, dispatched by `definition.name` — execution untouched (except `write`, whose `execute` is delegated to and then annotated with the old/new diff in `result.details`; if your execute stashes data in `details`, `write` loses it). `decorate` **throws** on an unknown name — guard with `kit.hasTool(name)` when the decorate is a security decision (a throw inside `session_start` aborts the rest of YOUR handler, and the unguarded tool stays reachable).

### Sample A — override bash's execution, keep the rendering (import)

```ts
import {
  createBashToolDefinition,
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createRenderKit } from "pi-pigment/render-kit";

export default function sandboxedBash(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Rebuild through the SDK factory — pi's own definition is not
    // obtainable (#7800). Carry the shell settings or a configured
    // shellCommandPrefix/shellPath is silently dropped from the command
    // that actually RUNS (same trust gate as pi: an untrusted project's
    // .pi/settings.json must not shape execution).
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    const mine = {
      ...createBashToolDefinition(ctx.cwd, {
        commandPrefix: settings.getShellCommandPrefix(),
        shellPath: settings.getShellPath(),
      }),
      execute: mySandboxedExecute, // ← only execution is yours
    };

    const kit = await createRenderKit({ cwd: ctx.cwd });
    if (!kit.hasTool(mine.name)) {
      pi.registerTool(mine); // degrade to your own rendering, never worse
      return;
    }
    pi.registerTool(kit.decorate(mine));
  });
}
```

### Sample B — same thing with zero dependency (publication channel)

Read the published surface off `globalThis` — the same implementation (channel B is a publication of channel A, never a second API). Read it in `session_start`, not at module top level: extensions load serially, so a global pi-pigment may not be imported yet when your factory runs; `session_start` fires after ALL factories.

```ts
const KIT_KEY = "pi-pigment.render-kit.v1";

interface KitLike {
  version: number;
  tools: readonly string[];
  createRenderKit(options: { cwd: string }): Promise<{
    tools: readonly string[];
    decorate(definition: unknown): unknown;
  }>;
}

export default function sandboxedBash(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const raw = (globalThis as Record<symbol | string, unknown>)[Symbol.for(KIT_KEY)] as
      KitLike | undefined;
    // Version/shape mismatch degrades to "absent" — never throw; render
    // decoration is not worth breaking a session over.
    if (!raw || raw.version !== 1 || !raw.tools.includes("bash")) {
      pi.registerTool(mine); // plain registration, never worse
      return;
    }
    const kit = await raw.createRenderKit({ cwd: ctx.cwd });
    pi.registerTool(kit.decorate(mine));
  });
}
```

Publication is idempotent (first publisher wins — `/reload` does not swap the object you hold).

### Sample C — rendering outside a tool slot

`registerMessageRenderer` hands you a `Theme` but no working directory — capture the session at `session_start`, bind per render:

```ts
import type { RenderSession } from "pi-pigment/render-kit";

export default function myNotes(pi: ExtensionAPI) {
  let session: RenderSession | undefined;
  pi.on("session_start", async (_event, ctx) => {
    const kit = await createRenderKit({ cwd: ctx.cwd });
    session = kit.session; // one resolution per session — reuse it
  });

  pi.registerMessageRenderer("my-note", (message, _options, theme) => {
    const view = session?.forTheme(theme);
    if (!view) return undefined; // no session yet: pi's default rendering
    return renderNote(message.text, view.scheme); // your renderer
  });
}
```

A `RenderView` carries `scheme` (derived colors), `theme` (the active theme object), `highlight(...)` (Shiki highlighting themed by THIS session), and `activeTheme()` (the resolved token theme — diagnostics).

`highlight` takes two spellings — `{ code, language }` when you know the language, `{ code, filePath, context? }` when you know the file (detection and seeding inside; no I/O, the context text is caller-supplied, the seed is the text before the slice):

```ts
const lines = await view.highlight({ code, language: "typescript" });
const lines = await view.highlight({
  code: slice,
  filePath: "src/app.vue",
  context: { text: fullText, startLine: 42 }, // omit for whole files
});
```

Without `context` an embedded-grammar slice (vue/html) renders unseeded — pass the full text when slice color accuracy matters.

### What the kit does NOT lend

`decorate` lends **whole-tool renderers** (grep's match highlighting, header ellipsis, and friends come along as tool behavior; your `execute` and metadata stay yours). Single-feature primitives (`emphasize`, `renderHeaderLine`, …) are not on the kit surface — for your own renderers, compose from `view.highlight` + the `view.scheme` color slots. This keeps the contract small; the session seam (`RenderSession`/`RenderView`) is the stable composition point.

### Pitfalls (all pinned by tests or verified against the SDK source)

1. **Read the publication in `session_start`, never at module top level** (serial load order; the publication may not exist when your factory runs).
2. **Rebuild bash through the SDK factory with the shell settings** (`createBashToolDefinition(cwd)` alone drops `shellCommandPrefix`/`shellPath`; Sample A has the trust gate).
3. **`decorate` throws on an unknown name** — a silent passthrough would look like it worked. The throw skips the rest of your `session_start` handler (other extensions unaffected).
4. **First-wins still applies to your registration** — register through `decorate`, or disable pi-pigment's tool with `disabledTools`.
5. **Channel-B mismatches degrade, never throw** — treat a foreign payload as absent (Sample B).
6. **The kit is per session** — constructing per render re-reads the config layers and re-reports their issues.
7. **`decorate` returns `ToolDefinition`, not your exact type** — the renderer slots use pi-pigment's projection of pi's `ToolRenderContext` (upstream exports it only from internals). Assign where a `ToolDefinition` is accepted, never back to a `T`-typed variable.

## Theme-level integration

Ship pi themes, get pi-pigment's best rendering for free — no API, no dependency:

- **Any pi theme works.** The `auto` syntax path derives token colors from every theme's nine `syntax*` colors (WCAG-adjusted against the real backgrounds).
- **The `pigment-` naming contract.** A pi theme named `pigment-<shiki-name>` maps back to its original Shiki theme for full-`tokenColors` precision (bundled sources AA-fitted at render time, user-converted verbatim). Fork it under a different name and it degrades to the derived path: correct, less precise.
- **Conversion for your users.** `/pigment convert` on a TextMate file (`.json`/`.tmTheme`) registers a `pigment-<stem>` pi theme with the precise pipeline attached. Your extension need not participate.

See [ADR 0006](adr/0006-theme-provider-architecture.md) and [config.md](config.md).

## Coexistence: first-wins, and how pi-pigment yields

1. **pi-pigment occupies the seven built-in names** (`write`, `edit`, `bash`, `powershell`, `grep`, `ls`, `find`) by same-name registration ([ADR 0005](adr/0005-rendering-only.md)). Register one of these after pi-pigment and yours is silently dropped.
2. **Occupied names are yielded, not shadowed.** Before registering, pi-pigment reads pi's merged registry: any of the seven already claimed by a non-`builtin` source is skipped with a one-line notice. Factory-time registration always qualifies — register in your factory and pi-pigment never touches the name.
3. **Search yields to pi-fff.** With pi-fff's vocabulary (`/fff-mode`) present, pi-pigment never registers `grep`/`find`, regardless of load order.
4. **Everything else is yours via the kit.** Whoever wins a name borrows the rendering back (samples A/B): the winner owns semantics, pi-pigment supplies rendering on request.
5. **Users can opt out per tool** with `disabledTools`.

Order caveat: the yield only sees tools registered before pi-pigment's `session_start` fires. Registering in your own later `session_start` keeps pi-pigment's wrapper live and drops yours (conflict log, no notice from pi-pigment). Prefer factory-time registration, the kit, or `disabledTools`.

## API stability

- `pi-pigment/render-kit` is the public surface: `render-kit.ts` at the package root, exporting straight from the defining modules. The published key set is contract-tested, and a borrow renders byte-identically to pi-pigment's own wrappers. Everything under `src/` is internal and may change without notice.
- `payload.version` is the wire protocol (`RENDER_KIT_PROTOCOL_VERSION`), a mismatch means "absent" to a well-behaved consumer (Sample B). `packageVersion`/`VERSION` is the pi-pigment release, informational. Do not confuse the two; the payload's type is `RenderKitPublication`.
