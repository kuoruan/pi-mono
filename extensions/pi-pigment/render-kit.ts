/**
 * The public render-kit entry (`pi-pigment/render-kit`) — the borrowing
 * surface third-party extensions import, sitting next to `index.ts` (the
 * extension entry) so the package root holds the two public entries and
 * `src/` stays internal.
 *
 * Exports come straight from the defining modules (no pass-through layer):
 * the kit itself from `src/render/kit.ts` (its `publishRenderKit()` feeds
 * the publication channel), the session seam from `src/render/session.ts`.
 */

/** The package version — the version module reads package.json once. */
export { PACKAGE_VERSION } from "./src/package-json.ts";

export {
  createRenderKit,
  publishRenderKit,
  RENDER_KIT_KEY,
  RENDER_KIT_PROTOCOL_VERSION,
  type RenderKitPublication,
  type RenderKit,
  type RenderKitOptions,
} from "./src/render/kit.ts";
export {
  createRenderSession,
  type RenderSession,
  type RenderView,
  type RenderSessionInputs,
} from "./src/render/session.ts";
