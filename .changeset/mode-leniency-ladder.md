---
"pi-permission-ai-guard": minor
---

Replace the 3-mode verdict policy (`manual`/`default`/`auto`) with a five-mode leniency ladder — `strict`, `default`, `advisory`, `lenient`, `permissive`. Hard-tier denies (riskLevel high|critical, or missing) stay terminal in every mode; soft denies and the model's own uncertainty map per mode; reviewer machinery failures never map to allow. The ctrl+alt+g cycle visits only the middle three (`default → advisory → lenient`), and the footer renders `permissive` in warning red.
