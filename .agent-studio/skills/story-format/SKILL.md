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

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
```

Rules: a story is Done only with evidence; mocks never prove a real provider; keep stories small (one developer session).
