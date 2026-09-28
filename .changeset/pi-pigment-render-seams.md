---
"pi-pigment": patch
---

Internal render cleanup with no visible change: settled frames release their resources through one hook, the shell failure badge lives in one module, and per-shell differences are declared in one place. Test fixtures gain shared helpers so suites stop repeating the same shapes.
