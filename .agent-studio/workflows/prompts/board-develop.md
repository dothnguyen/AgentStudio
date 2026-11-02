IMPLEMENT THE TICKET in this worktree. TASK is the ticket: its plan, acceptance criteria and any earlier QA or review findings.

1. If TASK has a "Merge conflicts with main" section, first resolve every conflict marker in the listed files, keeping the intent of both sides (main's changes are merged work: keep them). `rg -n '^(<<<<<<<|=======|>>>>>>>)'` must find nothing.
2. Fix earlier blockers first; suggestions are optional unless the ticket requires them.
3. Implement every required behaviour, including failure and edge cases, and make sure each has an automated test (backend: tests/, app: app/test/). Reuse existing tests where they already cover it. Stay within the ticket: no unrelated refactors, no package script changes unless the ticket asks.
4. UI work with a referenced mockup: view the image first and match the ticket's assigned regions (layout, spacing, typography, colours, controls) using real data. If you cannot view it, say so; never claim visual fidelity you did not check.

TESTS. Your sandbox cannot run the full suite; the coordinator runs it for you. When ready, request the suite that fits the files the ticket changed (`test-ui`, `test-backend` or `test-all`, as described in DELEGATED_COMMANDS) and end your turn with a short summary; you are re-dispatched with the result. If it failed, fix the cause (not the test, unless the test is wrong) and run it again. Pass only when the latest run of that suite succeeded and you changed nothing after it (if a later edit widened the change, run the wider suite). `test-touched` and `test-unit` are quick checks while iterating and never count. Runs are limited, so fix everything you can see before each run. Never report results you did not get from a delegated run.

Fail only when you cannot make the tests pass or cannot meet the ticket; write each reason as a finding.

LIVE CHECKS (launching the app, real provider accounts, a live end-to-end run) can only be done by a person. Never fail for them, never try them, and never produce or ask for recorded evidence (screenshots, captures, live-run logs): tests are the proof. List each as "OPERATOR CHECK: <what to run and what to see>" in your summary.

Do not:
- delete, reinstall or rebuild dependencies (`rm -rf node_modules`, `npm ci`, `npm install`, `npm rebuild`) or ask permission to. If dependencies are broken and DELEGATED_COMMANDS offers a fix, request it and end your turn; otherwise carry on and report what you could not run.
- run git commands that change history or the working tree (commit, reset, stash, checkout, clean): the coordinator commits your work.
- edit the ticket.

Before finishing, re-read the whole ticket and the whole diff (`git diff main...HEAD` plus uncommitted changes). Finish with a checklist mapping each acceptance criterion and earlier blocker to its code or test, the suite you ran and its last result, anything you could not check, then your verdict.

This is attempt {{visit}} of stage {{stage}}.

{{delegated_commands}}

{{task}}
{{findings}}
