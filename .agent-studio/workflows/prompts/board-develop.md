IMPLEMENT THE TICKET. Read the entire TASK, including its implementation plan, acceptance criteria, edge cases, dependencies and previous QA or review findings. Make a working checklist of every required behavior. For each item, identify the responsible code, implement or verify the behavior (including relevant failure and boundary cases), and identify an existing test that proves it or add an appropriate automated test. Fix previous blockers first; treat suggestions as optional unless the ticket requires them. Keep changes focused on the ticket.

For UI work with a referenced mockup, open and inspect the image with an available image-viewing tool before implementing. Strictly follow the ticket's assigned design regions: match the visual hierarchy, layout, alignment, spacing, typography, colors, borders and controls, adapting them only for real data, accessibility and supported screen sizes. Do not substitute a generic layout for the design. Check the implementation against the image using available rendering or screenshot tools, and add meaningful automated coverage for specified design behavior. If image inspection or visual comparison is unavailable, report that limitation explicitly; do not claim visual fidelity was verified or invent the missing details. Do not make a manual live-app check a workflow gate.

If the ticket has a "Merge conflicts with main" section, the listed files contain git conflict markers (<<<<<<<, =======, >>>>>>>) from merging main into this branch. Resolve every one first, keeping the intent of both sides (main's changes are already merged work: do not drop them), and make sure no marker is left anywhere (`rg -n '^(<<<<<<<|=======|>>>>>>>)'`).

Use the appropriate test locations and level for the change: backend tests under tests/ and app tests under app/test/. Test the requested behavior and meaningful failure cases, rather than only implementation details; use existing tests when they already provide sufficient coverage. Do not add or alter package scripts unless the ticket requires it.

TEST VERIFICATION IS YOURS. There is no separate validation step after you: the ticket moves to QA only when you pass it, and Agent Studio accepts your pass only if the delegated test suite for your change succeeded in this run on exactly the code you hand over. Your sandbox cannot run the full suite (integration tests, npm test, typecheck, build), so the coordinator runs it for you:
1. When your implementation and tests are ready, request the suite for your change (see DELEGATED_COMMANDS) and end your turn with a short summary of what you changed and what is left. `test-touched` and `test-unit` are quicker checks while iterating, but they never count.
   Choose the suite from the files the ticket changed (`git diff main...HEAD --name-only`, plus your uncommitted changes):
   - only `app/` changed (src, test, package files): `test-ui` (npm test, typecheck, build for the app; no backend tests);
   - only the backend changed (`backend/`, `tests/`): `test-backend` (backend unit and integration tests; no app tests);
   - both, or neither (docs, configuration, planning files), or if you are unsure: `test-all`. `scripts/` counts as both.
   Agent Studio works out the same thing from the changed files and accepts a pass only if that suite (or `test-all`, which covers any of them) succeeded on your final code, so the narrower suite is safe to use and saves a long run.
2. You are re-dispatched with the result in a DELEGATED section. Read it as the source of truth. If anything failed, investigate, fix the cause (not the test, unless the test is wrong), and request the suite again.
3. Pass only when the latest run of the required suite succeeded and you changed nothing after it; any later edit, even a comment, means you must run it again. If your last edit widened the change (for example you touched the backend after a `test-ui` run), run the wider suite. Never claim a pass from tests you ran yourself.
4. Fail only when you cannot make the tests pass or cannot meet the ticket; write each reason as a finding. You have a limited number of delegated runs per attempt, so fix everything you can see before running again.

Never delete, reinstall or rebuild dependencies yourself: do not run `rm -rf node_modules`, `npm ci`, `npm install` or `npm rebuild`, and do not request permission to run them (your sandbox declines them and the run would stop). The project README's advice to re-run `npm ci` is for people, not for you. If dependencies are missing, unusable, or linked outside the worktree, and DELEGATED_COMMANDS below offers a command that fixes it, request that command and end your turn with a short summary of where you are; you will be re-dispatched with its result. If no command fits, or the request is refused, continue with the checks that are available and report the affected commands.

{{delegated_commands}}

Before finishing, re-read the entire ticket and review the complete ticket diff, not only your latest edits. Check every acceptance criterion and prior blocker against the implementation and tests. Report unmet or unverified requirements explicitly; do not claim completion if a required item is missing. Finish with a concise checklist mapping each criterion to its implementation or test, the suite you ran and the result of its final run, and any checks you could not run, then your verdict.

Do not run git commands that change history or the working tree (no commit, reset, stash, checkout, clean): the coordinator commits your work. Do not edit the ticket. Avoid unrelated refactors.

This is attempt {{visit}} of stage {{stage}}.

{{task}}
{{findings}}
