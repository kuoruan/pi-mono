# pi-permission-ai-guard

A pi-mono extension that security-reviews AI agent commands. A deterministic screen refuses a closed set of literal shapes; everything else reaches a review lane whose model answers questions and whose code decides.

## Scorecard

| Set                                | Result                                       | Status                                                          |
| ---------------------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| Design set, 212 cases, paper       | 210/212, unsafe-allow 0                      | one screen gap plus the header tightening's deliberate over-ask |
| Alignment, 212 cases, ideal labels | 186/212 agree, 26 intended unproven, 0 other | design check, not an acceptance test                            |
| Unit tests                         | green, `tsc` clean                           | —                                                               |

Neither number is a live run: both replay ideal labels, so they can show the table and the shared core agree with the corpus, and nothing about a real model.

## Doc map

- `policy.md` — what runs today (Part I) and the contract of the shared core both lanes will submit to (Part II).
- `decisions.md` — the accepted decisions, the prohibited shortcuts, and the measured results behind them.
- `adr/` — the fourteen decision records: 0001 no silent fallback, 0002 defer leans, 0003 one redaction boundary, 0004 the reviewer engine, 0005 the canonical classifier types, 0006 hard deny belongs to the screen, 0007 the model answers observable questions, 0008 the boundary is not the parser, 0009 protection weakening is a conjunction, 0010 the conditions any wiring must meet, 0011 an unreadable auth header is a send, 0012 the mode ladder is three built-in rungs plus a custom row, 0013 a reviewer allow cannot lift a proven irreversible effect, 0014 the irreversible axis belongs to the custom row.
- `prompt-principles.md` — rules the prompts follow (positive phrasing, one axis per question, no exclusions).
