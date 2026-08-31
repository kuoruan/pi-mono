---
"pi-permission-ai-guard": patch
---

Track pi-permission-system 29: the peer range accepts `^27.1.1 || ^28.0.0 || ^29.0.0`. v29 removes the deprecated process-root service slot — APIs this extension never referenced — so the breaking removal is a no-op; the suite passes under all three resolved majors. Development resolves `^29.0.0`.
