---
"pi-pigment": patch
---

wrapAnsi tracks SGR state incrementally (`SgrState` + literal-form fast classifier) instead of re-scanning each row at break; removed the now-unused `ansiState`.
