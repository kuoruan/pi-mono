---
"pi-pigment": minor
---

Third-party extensions can now borrow pi-pigment's rendering instead of racing it for the tool name: `pi-pigment/render-kit` installs the renderers on YOUR tool definitions (`decorate`) and leaves your `execute` untouched, and a zero-dependency publication channel (`globalThis[Symbol.for("pi-pigment.render-kit.v1")]`) serves extensions that must not import the package. Borrowed rendering is contract-tested byte-identical to pi-pigment's own wrappers. See `docs/integrating.md`.
