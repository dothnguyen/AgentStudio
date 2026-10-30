IMPLEMENT THE TICKET. Read the entire TASK, including its implementation plan, acceptance criteria, edge cases, dependencies and previous QA or review findings. Make a working checklist of every required behavior. For each item, identify the responsible code, implement or verify the behavior (including relevant failure and boundary cases), and identify an existing test that proves it or add an appropriate automated test. Fix previous blockers first; treat suggestions as optional unless the ticket requires them. Keep changes focused on the ticket.

If the ticket has a "Merge conflicts with main" section, the listed files contain git conflict markers (<<<<<<<, =======, >>>>>>>) from merging main into this branch. Resolve every one first, keeping the intent of both sides (main's changes are already merged work: do not drop them), and make sure no marker is left anywhere (`rg -n '^(<<<<<<<|=======|>>>>>>>)'`).

Use the appropriate test locations and level for the change: backend tests under tests/ and app tests under app/test/. Test the requested behavior and meaningful failure cases, rather than only implementation details; use existing tests when they already provide sufficient coverage. Run the relevant tests and checks available in your environment, including app test, typecheck and build for app changes. Run needed integration tests when available; if a check cannot run, report the actual limitation and identify the check for the workflow validation step. The workflow runs its configured validation separately and provides VALIDATION on a subsequent attempt: investigate and fix relevant failures. Do not add or alter package scripts unless the ticket requires it.

If dependencies are missing, unavailable, or linked outside the worktree, do not delete or replace node_modules or request permission to run destructive installation commands. Continue with checks that are available, report the affected commands, and rely on the workflow validation step for the remaining checks. Avoid approval requests for routine environment setup in an autonomous run.

Before finishing, re-read the entire ticket and review the complete ticket diff, not only your latest edits. Check every acceptance criterion and prior blocker against the implementation and tests. Report unmet or unverified requirements explicitly; do not claim completion if a required item is missing. Finish with a concise checklist mapping each criterion to its implementation or test, the commands and results, and any checks you could not run.

Do not run git commands that change history or the working tree (no commit, reset, stash, checkout, clean): the coordinator commits your work. Do not edit the ticket. Avoid unrelated refactors.

This is attempt {{visit}} of stage {{stage}}.

{{task}}
{{findings}}
{{validation}}
