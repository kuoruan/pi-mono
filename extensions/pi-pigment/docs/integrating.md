# Integrating with pi-pigment

How a third-party extension borrows pi-pigment's rendering — and what pi-pigment borrows back.

Three integration surfaces exist, in decreasing order of commitment:

| Surface                                                                 | What you get                                                           | What it costs you                                                   |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [Borrow the renderers (`render-kit`)](#borrow-the-renderers-render-kit) | pi-pigment's tool/message rendering on YOUR tool definitions           | a dependency on `pi-pigment` (or none, via the publication channel) |
| [Theme-level integration](#theme-level-integration)                     | your users get pi-pigment's full-precision rendering under your themes | nothing — it is the default behavior                                |
| [Coexistence rules](#coexistence-first-wins-and-yield)                  | your tools survive next to pi-pigment                                  | nothing — but read it before registering `bash`/`grep`/…            |

The integration contract is pinned by tests (`tests/render/kit.test.ts`): the published surface is asserted against the module exports, and a borrowed render is asserted byte-identical to pi-pigment's own.

## Why borrowing exists at all

pi's extension API has no renderer-only override: the only way to change how a tool renders is to register a same-name tool definition, and registration is **first-wins across extensions** (silently — 0.85.x emits no warning, see [ADR 0005](adr/0005-rendering-only.md)). pi-pigment renders the built-ins by occupying their names.

So if YOUR extension also registers `bash` (a sandboxed execute, an audit wrapper, an access-control gate), the two extensions race: whoever loads first wins, and the loser is dropped without a trace. pi-pigment's answer is **yield + lend**: it yields names it did not win, and lends its renderers to whoever won them. You keep your `execute`; pi-pigment keeps the pixels.

## Borrow the renderers (`render-kit`)

```bash
pi install npm:pi-pigment   # users install it once; or add it to your own package.json
```

```ts
import { createRenderKit } from "pi-pigment/render-kit";
```

`createRenderKit(options)` resolves the config layers and the theme selection **once per session** and returns a kit:

```ts
interface RenderKit {
  /** The tool names this build can decorate. */
  readonly tools: readonly ["bash", "powershell", "grep", "find", "ls", "write", "edit"];
  /** The session's render state — for rendering outside a tool slot. */
  readonly session: RenderSession;
  /**
   * Install pi-pigment's renderers on your definition, dispatched by
   * definition.name. Throws on an unknown name.
   */
  decorate(definition: ToolDefinition): ToolDefinition;
}
```

Options: `cwd` (required — the session's working directory), `agentDir` (defaults to `getAgentDir()`), `indicatorStyle` (defaults to the config layer), `reportIssue` (defaults to one stderr line).

### Sample A — override bash's execution, keep pi-pigment's rendering (import)

The most common case: your extension owns the execution, pi-pigment keeps the pixels.

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
    // Rebuild the bash definition through the SDK factory — pi's own
    // definition is not obtainable (#7800), so this is the only path, not
    // a style choice. Carry pi's shell settings or a configured
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
    // Access-control footgun: decorate THROWS on an unknown name, and a
    // throw inside session_start aborts the rest of YOUR handler — the
    // registration never happens and the unguarded tool stays reachable.
    // Guard when the decorate is a security decision:
    if (!kit.hasTool(mine.name)) {
      pi.registerTool(mine); // degrade to your own rendering, never worse
      return;
    }
    pi.registerTool(kit.decorate(mine));
  });
}
```

### Sample B — same thing with zero dependency (publication channel)

If your extension must not depend on `pi-pigment`, read the published surface off `globalThis`. It is the same implementation — channel B is a publication of channel A, never a second API:

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
    // Read it HERE, not at module top level: extensions load serially
    // (project before global), so a global pi-pigment may not have been
    // imported yet when your factory runs. session_start fires after ALL
    // factories, so the publication is guaranteed visible by then.
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

pi-pigment publishes at extension load (idempotently — first publisher wins, `/reload` does not swap the object you already hold).

### Sample C — rendering outside a tool slot

`registerMessageRenderer` hands you a `Theme` but no working directory — capture the session value at `session_start`, then bind per render:

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
    return renderNote(message.text, view.palette); // your renderer
  });
}
```

A `RenderView` carries `palette` (the derived diff/background colors), `piTheme` (the active theme object), `highlight({ code, language, seed? })` (Shiki highlighting themed by THIS session), and `activeTheme()` (which token theme the session resolved — useful for diagnostics).

### What `decorate` touches

| Tool                                          | Replaced                                      | Preserved                         |
| --------------------------------------------- | --------------------------------------------- | --------------------------------- |
| `bash` `powershell` `grep` `find` `ls` `edit` | `renderShell` / `renderCall` / `renderResult` | `execute` verbatim, your metadata |
| `write`                                       | the above **plus `execute`**                  | —                                 |

The `write` footgun: its wrapper delegates to your `execute`, then **overwrites** `result.details` with the old/new diff (assignment, not merge). If your execute stashes data in `details`, `write` is the one tool that loses it.

### Pitfalls (all pinned by tests or verified against the SDK source)

1. **Read the publication in your `session_start`, never at module top level** — load order is serial (project extensions before global), so the publication may not exist when your factory runs. `session_start` fires after all factories.
2. **Rebuild bash through the SDK factory with the shell settings** — `createBashToolDefinition(cwd)` alone drops `shellCommandPrefix`/`shellPath` (Sample A has the full recipe, trust gate included).
3. **`decorate` throws on an unknown name** — a silent passthrough would look like it worked. The throw lands in your `session_start`: the rest of your handler is skipped (other extensions are unaffected). For access-control intents, guard with `kit.tools` first (Sample A).
4. **First-wins still applies to your registration** — if pi-pigment loaded before you and you never use the kit, your `bash` is dropped silently. Register through `decorate`, or disable pi-pigment's tool with `disabledTools` in its config.
5. **Version/shape mismatches (channel B) degrade, never throw** — treat a foreign payload as absent (Sample B).
6. **The kit is per session** — construct it in `session_start`, hold the value; constructing per render re-reads the config layers and re-reports their issues.
7. **`decorate` returns `ToolDefinition`, not your exact type** — the renderer slots are typed with pi-pigment's projection of pi's `ToolRenderContext` (upstream exports that type only from its internals, so it cannot be spelled here), and your `T`'s own renderer types are not preserved. Assign the result where a `ToolDefinition` is accepted (`pi.registerTool`), or to a `ToolDefinition`-typed variable — never back to a `T`-typed one.

## Theme-level integration

If you ship pi themes rather than tools, you get pi-pigment's best rendering for free — no API, no dependency:

- **Any pi theme works.** pi-pigment's `auto` syntax path derives token colors from every theme's nine `syntax*` colors (WCAG-adjusted against the real backgrounds). Users with your theme installed get matching highlighting out of the box.
- **The `pigment-` naming contract.** A pi theme named `pigment-<shiki-name>` (or a user-converted `pigment-<stem>.json`) maps back to its original Shiki theme for full-`tokenColors` precision — bundled sources AA-fitted at render time, user-converted sources verbatim. If you fork or re-ship one of these files under a different name, it degrades to the derived path: still correct, less precise.
- **Conversion for your users.** A user pointing `/pigment convert` at a TextMate theme file (`.json` or `.tmTheme`) gets a registered `pigment-<stem>` pi theme with pi-pigment's precise rendering pipeline attached. Your extension need not participate.

See [ADR 0006](adr/0006-theme-provider-architecture.md) for the two-layer model (pi theme = base; `syntaxTheme` config = token override) and [config.md](config.md) for the user-facing knobs.

## Coexistence: first-wins, and how pi-pigment yields

The rules your extension lives under when pi-pigment is installed:

1. **pi-pigment occupies the seven built-in names** (`write`, `edit`, `bash`, `powershell`, `grep`, `ls`, `find`) by same-name registration — the API's only rendering-override mechanism ([ADR 0005](adr/0005-rendering-only.md)). If your extension registers one of these names and loads AFTER pi-pigment, your registration is silently dropped by pi.
2. **Search yields to pi-fff.** When pi-fff's vocabulary (`/fff-mode`) is present, pi-pigment does not register `grep`/`find` at all, so pi-fff owns them regardless of load order. If you wrap search tools, yield the same way or use the kit.
3. **Everything else is yours via the kit.** Any other extension that wins one of the seven names can borrow the rendering back (samples A/B). That is the intended division: the winner owns semantics; pi-pigment supplies rendering on request.
4. **Users can opt out per tool**: `disabledTools` in pi-pigment's config layer stops the wrapper for that tool, leaving the name to whoever registers it next.

## API stability

- `pi-pigment/render-kit` is the public integration surface: `render-kit.ts` at the package root, exporting straight from the defining modules (`src/render/kit.ts` for the kit, `src/render/session.ts` for the session seam). The package root holds the two public entries — `index.ts` for the extension, `render-kit.ts` for consumers — and everything under `src/` is internal. Its published key set is contract-tested against the module exports, and a borrow renders byte-identically to pi-pigment's own wrappers.
- `version: 1` in the publication payload is the wire protocol
  (`RENDER_KIT_PROTOCOL_VERSION` — the publication contract, not the package
  release); a mismatch means "absent" to a well-behaved consumer (Sample B).
  `packageVersion` is informational (read from pi-pigment's `package.json`,
  also exported as `VERSION`), for logging next to it. Three different
  versions ride this channel — do not confuse them: `VERSION` is the
  pi-pigment release, `payload.version` is the wire protocol the publication
  speaks, and `RENDER_KIT_PROTOCOL_VERSION` is the protocol this build
  implements. The payload's type is `RenderKitPublication`.
- Everything else under `pi-pigment` (the main entry, internals, theme files) is the extension's own surface and may change without notice.
