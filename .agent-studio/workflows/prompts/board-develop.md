IMPLEMENT THE TICKET. Read the entire TASK, including its implementation plan, acceptance criteria, edge cases, dependencies and previous QA or review findings. Make a working checklist of every required behavior. For each item, identify the responsible code, implement or verify the behavior (including relevant failure and boundary cases), and identify an existing test that proves it or add an appropriate automated test. Fix previous blockers first; treat suggestions as optional unless the ticket requires them. Keep changes focused on the ticket.

For UI work with a referenced mockup, open and inspect the image with an available image-viewing tool before implementing. Strictly follow the ticket's assigned design regions: match the visual hierarchy, layout, alignment, spacing, typography, colors, borders and controls, adapting them only for real data, accessibility and supported screen sizes. Do not substitute a generic layout for the design. Check the implementation against the image using available rendering or screenshot tools, and add meaningful automated coverage for specified design behavior. If image inspection or visual comparison is unavailable, report that limitation explicitly; do not claim visual fidelity was verified or invent the missing details. Do not make a manual live-app check a workflow gate.

If the ticket has a "Merge conflicts with main" section, the listed files contain git conflict markers (<<<<<<<, =======, >>>>>>>) from merging main into this branch. Resolve every one first, keeping the intent of both sides (main's changes are already merged work: do not drop them), and make sure no marker is left anywhere (`rg -n '^(<<<<<<<|=======|>>>>>>>)'`).

Use the appropriate test locations and level for the change: backend tests under tests/ and app tests under app/test/. Test the requested behavior and meaningful failure cases, rather than only implementation details; use existing tests when they already provide sufficient coverage. Run the relevant tests and checks available in your environment, including app test, typecheck and build for app changes. Run needed integration tests when available; if a check cannot run, report the actual limitation and identify the check for the workflow validation step. The workflow runs its configured validation separately and provides VALIDATION on a subsequent attempt: investigate and fix relevant failures. Do not add or alter package scripts unless the ticket requires it.

Never delete, reinstall or rebuild dependencies yourself: do not run `rm -rf node_modules`, `npm ci`, `npm install` or `npm rebuild`, and do not request permission to run them (your sandbox declines them and the run would stop). The project README's advice to re-run `npm ci` is for people, not for you. If dependencies are missing, unusable, or linked outside the worktree, and DELEGATED_COMMANDS below offers a command that fixes it, request that command and end your turn with a short summary of where you are; you will be re-dispatched with its result. If no command fits, or the request is refused, continue with the checks that are available, report the affected commands, and rely on the workflow validation step for the rest.

{{delegated_commands}}

Before finishing, re-read the entire ticket and review the complete ticket diff, not only your latest edits. Check every acceptance criterion and prior blocker against the implementation and tests. Report unmet or unverified requirements explicitly; do not claim completion if a required item is missing. Finish with a concise checklist mapping each criterion to its implementation or test, the commands and results, and any checks you could not run.

Do not run git commands that change history or the working tree (no commit, reset, stash, checkout, clean): the coordinator commits your work. Do not edit the ticket. Avoid unrelated refactors.

This is attempt {{visit}} of stage {{stage}}.

{{task}}
{{findings}}
{{validation}}
