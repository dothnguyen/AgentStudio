# P05-S17 — Teams screen accessibility and Windows plus WSL live gate

Status: To Do
Depends on: P05-S14, P05-S15, P05-S16
Architecture: [Teams management architecture](../README.md#architecture-and-gaps)

## Goal
Complete responsive and accessibility acceptance and prove Teams management against the real Windows Electron app and WSL backend. Compare to `design/teams-screen-v1.png` once present, treating pictured values as illustrative.

## Implement in this order
1. Audit keyboard order, labels, focus, semantics, contrast, reduced motion, long text, narrow widths, and error/empty states.
2. Run app/backend automated suites and capture desktop/narrow visual evidence; run the actual Windows plus WSL workflow with catalog/team edits, live board controls and routing.
3. Record commands, screenshots, backend events and observed results in this story’s Evidence; block Done if the design asset or live environment is unavailable.

## Done when
- [ ] Screen is usable by keyboard and at supported narrow width with no clipping. Test: accessibility/component tests and visual review.
- [ ] A real Windows app drives WSL management, board start/stop, and a rule validation path with durable evidence. Test: live validation, not mocks.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
