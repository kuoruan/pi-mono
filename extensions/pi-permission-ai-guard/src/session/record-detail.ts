/**
 * The record detail dialog: the reading surface for a picked record from
 * a read-only panel (`/ai-guard denied`, `/ai-guard report`). The panel's
 * list stays on the host's standard `ui.select` (the same full-screen
 * picker the settings menu uses); this dialog is what a picked entry
 * opens — a floating window over the conversation carrying the command
 * and its full text without truncation (the list line is a scan index,
 * the dialog is the reading surface).
 *
 * Built on pi-tui components via the host's `ctx.ui.custom` overlay, so
 * it reads as native UI rather than an extension bolt-on. Enter or esc
 * closes (returns to the conversation — the list itself is already
 * done).
 */

import { type ThemeColor } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { type Component, type Keybinding } from "@earendil-works/pi-tui";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";

/**
 * A field row: a short label and its value, rendered as two aligned
 * columns (label padded to the block's widest label).
 */
export interface DetailField {
  readonly kind: "field";
  /** The short label ("risk level", "request id"). */
  readonly label: string;
  /** The value (shown whole; long values wrap below the label column). */
  readonly value: string;
}

/**
 * A prose block: free text rendered full-width in the given tone —
 * "text" for values (the reason), "muted" for guidance sentences.
 */
export interface DetailText {
  readonly kind: "text";
  /** The prose (long text is soft-wrapped by the Text component). */
  readonly text: string;
  /** The tone: "text" reads as content, "muted" as annotation. */
  readonly tone: "text" | "muted";
}

/**
 * An emphasis block: the copyable payload (a suggested rule), rendered
 * on its own accent-colored line — the thing the dialog exists to hand
 * over.
 */
export interface DetailEmphasis {
  readonly kind: "emphasis";
  /** The payload line (shown whole, untruncated). */
  readonly text: string;
}

/** One rendered body block. */
export type DetailBlock = DetailField | DetailText | DetailEmphasis;

/** What the picked record shows in the dialog. */
export interface RecordDetail {
  /** The header line: the panel's framing for the record. */
  title: string;
  /** The command, shown whole (no list-line truncation). */
  command: string;
  /** The body blocks, in display order. */
  body: readonly DetailBlock[];
}

/** What the dialog tells its caller happened. */
export type RecordDetailResult = "closed";

/**
 * The theme's legal background-color keys. The host's `ThemeBg` is not
 * exported through its package surface (only `ThemeColor` is), so this
 * mirrors it — a new host background key needs a one-line sync here,
 * and a typo becomes a compile error either way.
 */
export type DialogThemeBg =
  | "selectedBg"
  | "scrollbarThumb"
  | "searchMatchBg"
  | "userMessageBg"
  | "customMessageBg"
  | "toolPendingBg"
  | "toolSuccessBg"
  | "toolErrorBg";

/**
 * The theme slice a dialog component consumes — structurally the host's
 * `Theme` narrowed to what the dialogs use, with the color keys typed
 * so a wrong key is a compile error (the runtime throws "Unknown theme
 * color" — the type keeps that a never-event).
 */
export interface DialogTheme {
  fg(kind: ThemeColor, text: string): string;
  bg(kind: DialogThemeBg, text: string): string;
  bold(text: string): string;
}

/**
 * The keybindings slice a dialog component consumes — structurally the
 * host's `KeybindingsManager` narrowed to the matches call, with the
 * action typed as the pi-tui keybinding union (a typo'd action name is
 * a compile error, not a silently-never-matching key check).
 */
export interface DialogKeybindings {
  matches(data: string, action: Keybinding): boolean;
}

/**
 * The overlay options shape a custom-dialog call carries (the slice of
 * the host's OverlayOptions the dialogs use).
 */
export interface DialogOverlayOptions {
  overlay?: boolean;
  overlayOptions?: Record<string, unknown>;
}

/**
 * The host's custom-component entry (`ctx.ui.custom`), typed as the
 * dialogs consume it: a factory over the TUI/theme/keybindings slices
 * and the overlay options. Structurally assignable from the host's own
 * generic method.
 */
export type CustomDialogFn = <T>(
  factory: (
    tui: { requestRender(): void },
    theme: DialogTheme,
    keybindings: DialogKeybindings,
    done: (result: T) => void,
  ) => Component,
  options?: DialogOverlayOptions,
) => Promise<T>;

/**
 * Show a record's detail as an overlay; resolves when it closes.
 *
 * No own hasUI gate, by design: every reachable caller already gated
 * the list that produced the pick (a pick cannot happen without an
 * interactive list), and `ctx.ui.custom` in a UI-less environment
 * degrades to an immediate resolve — the detail is advisory either
 * way. A future caller that reaches here without a list should gate
 * itself.
 *
 * @param custom - The host's custom-component entry (`ctx.ui.custom`).
 * @param detail - The picked record's full content.
 * @returns Resolves "closed" when the dialog dismisses.
 */
export async function showRecordDetail(
  custom: CustomDialogFn,
  detail: RecordDetail,
): Promise<RecordDetailResult> {
  return custom<RecordDetailResult>(
    (_tui, theme, keybindings, done) => new RecordDetailComponent(theme, keybindings, detail, done),
    { overlay: true, overlayOptions: { anchor: "center", width: "75%", maxHeight: "80%" } },
  );
}

/**
 * The dialog's component: a single reading view. Any of the select
 * actions (enter or esc) closes — there is nothing to navigate to.
 */
class RecordDetailComponent implements Component {
  #frame: Container;
  #keybindings: DialogKeybindings;
  #done: (result: RecordDetailResult) => void;

  constructor(
    theme: DialogTheme,
    keybindings: DialogKeybindings,
    detail: RecordDetail,
    done: (result: RecordDetailResult) => void,
  ) {
    this.#keybindings = keybindings;
    this.#done = done;
    // The official dialog frame: border → spacer → title → spacer →
    // body → spacer → help → border — the same rhythm every host dialog
    // (and pps's settings modal) uses, so the overlay reads as native.
    this.#frame = new Container();
    this.#frame.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    this.#frame.addChild(new Spacer(1));
    this.#frame.addChild(new Text(theme.fg("accent", theme.bold(detail.title)), 1, 0));
    this.#frame.addChild(new Spacer(1));
    // The command is the record's identity — its own emphasized block,
    // whole (the list line truncated it; this surface exists not to).
    const command = new Box(2, 0, (text) => theme.bg("customMessageBg", text));
    command.addChild(new Text(detail.command, 0, 0));
    this.#frame.addChild(command);
    this.#frame.addChild(new Spacer(1));
    // Body blocks: fields render as two aligned columns (label padded
    // to the block's widest label, value beside it), prose and emphasis
    // full-width in their tones.
    const labelWidth = Math.max(
      ...detail.body.filter((b): b is DetailField => b.kind === "field").map((f) => f.label.length),
      0,
    );
    let prev: DetailBlock["kind"] | undefined;
    for (const block of detail.body) {
      // A group change earns a blank line: prose above fields, anything
      // above the emphasis payload. Same-kind runs stay tight (field
      // rows align as one block).
      if (prev !== undefined && prev !== block.kind) {
        this.#frame.addChild(new Spacer(1));
      }
      if (block.kind === "field") {
        this.#frame.addChild(
          new Text(theme.fg("muted", block.label.padEnd(labelWidth)) + `  ${block.value}`, 1, 0),
        );
      } else if (block.kind === "emphasis") {
        this.#frame.addChild(new Text(theme.fg("accent", block.text), 1, 0));
      } else {
        this.#frame.addChild(
          new Text(block.tone === "muted" ? theme.fg("muted", block.text) : block.text, 1, 0),
        );
      }
      prev = block.kind;
    }
    this.#frame.addChild(new Spacer(1));
    // The host's keyHint shape: key name dim, description muted.
    this.#frame.addChild(
      new Text(theme.fg("dim", "enter/esc") + theme.fg("muted", " close"), 1, 0),
    );
    this.#frame.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
  }

  render(width: number): string[] {
    return this.#frame.render(width);
  }

  invalidate(): void {
    this.#frame.invalidate();
  }

  handleInput(data: string): void {
    if (
      this.#keybindings.matches(data, "tui.select.confirm") ||
      this.#keybindings.matches(data, "tui.select.cancel")
    ) {
      this.#done("closed");
    }
  }
}
