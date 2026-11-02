# Story format (Agent Studio)

Stories live in phases/phase-NN/stories/PNN-SMM-short-name.md and are listed in that folder's README.md table.

```
# PNN-SMM — Title

Status: To Do | In Progress | Blocked — reason | Done (YYYY-MM-DD)
Depends on: PNN-Sxx (...)
Architecture: link to the phase architecture section

## Goal
One paragraph.

## Implement in this order
1. ...

## Done when
- [ ] testable outcome
- [ ] tests: which unit / integration tests prove it
```

Rules: a story is Done when every "Done when" item is proved by passing unit or integration tests; never require live checks, manual app runs, screenshots or other recorded evidence (list anything that needs a person as an operator check, outside "Done when"); mocks never prove a real provider; keep stories small (one developer session).
