/**
 * The host UI-context double for the command and shortcut suites: one
 * definition of what a UI host looks like, so a method signature lands
 * here once instead of drifting between the wiring and settings tests.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

/**
 * A command/shortcut UI context with spies for every method the handlers
 * reach for.
 *
 * @param selectResult - What `ui.select` resolves with (undefined = cancel).
 * @returns The mock ctx.
 */
export function makeUiCtx(selectResult?: string) {
  return {
    hasUI: true,
    ui: {
      notify: vi.fn<(message: string, type?: "info" | "warning" | "error") => void>(),
      setStatus: vi.fn<(key: string, text: string | undefined) => void>(),
      select: vi.fn<(title: string, options: string[]) => Promise<string | undefined>>(
        async () => selectResult,
      ),
      custom: vi.fn<() => Promise<string>>(
        async () => "closed",
      ) as unknown as ExtensionUIContext["custom"],
    },
  };
}