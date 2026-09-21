/**
 * The UI-context subset the settings surface uses — derived from the host's
 * contexts so the method signatures can't drift. Structurally satisfied by
 * the real ExtensionContext / ExtensionCommandContext; the narrow shape
 * keeps test fixtures light.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export interface AiGuardUiContext {
  /** Picker / notify / footer-status / overlay-dialog surface. */
  ui: Pick<ExtensionUIContext, "select" | "notify" | "setStatus" | "custom">;
  /** Whether dialog-capable UI is available (TUI/RPC) — gates the picker paths. */
  hasUI: boolean;
}
