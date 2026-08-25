# No root-slot fallback when a host yields no session id

pi-permission-system v27 keys permission services by session id, and the
deprecated `getRootPermissionsService()` still resolves the root slot for
hosts that predate the id. When a host yields no session id (neither the
`permissions:ready` payload nor the session_start self-read produces one),
the ai-guard link deliberately does NOT fall back to that root locator: it
stays unregistered and every ask defers.

**Considered options** — (A) fall back to `getRootPermissionsService()`
when the id is missing (mirrors upstream's own legacy-host behavior, ~6
lines), or (B) skip registration entirely. B was chosen: the v27 model is
session-keyed end-to-end and the root slot is deprecated with removal
deferred only to a future upstream major; registering onto it would wire
this link to an API the model is walking away from and would attach it to
a slot whose routing semantics on multi-node hosts are undefined for this
link. The extension keeps zero references to the deprecated surface.

**Consequences** — hosts below the declared peer floor, and any host whose
session id is unreachable, lose review coverage the moment both sources
report null; the observable is a fail-safe defer-everything, identical to
"no service published". This is an accepted, documented degradation, not an
oversight — do not "fix" it by re-adding the root-slot fallback without
revisiting this decision.
