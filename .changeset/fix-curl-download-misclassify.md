---
"pi-permission-ai-guard": patch
---

Restructure the External Code Execution rule so the fetch-to-inspect carve-out leads the entry and names `curl -sL`/`wget` (no interpreter pipe) as the canonical download-inspect form, preventing the model from misclassifying plain remote downloads as DENY-Always code execution.
