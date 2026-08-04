import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createAiGuardExtension } from "./extension.ts";

export default function (pi: ExtensionAPI): void {
  createAiGuardExtension(pi);
}
