import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createPigmentExtension } from "./extension.ts";

export default function (pi: ExtensionAPI): void {
  createPigmentExtension(pi);
}
