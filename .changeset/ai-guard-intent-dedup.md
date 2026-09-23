---
"pi-permission-ai-guard": patch
---

Bare user continuations ("go on") no longer consume transcript quota, and adjacent exact repeats collapse to one: the stripper drops both before the window fills, so neither evicts the real task sentence the intent check authorizes against. Closed word list with exact matching across English, Simplified and Traditional Chinese; narrowing signals ("stop", "wait", "no") are excluded and keep the anchor slot.
