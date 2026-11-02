REFINE ONE STORY so a developer on a less capable model can implement it without design decisions. TASK is the ticket (its key is on the first line); if it has a `Story file:` line, read that file too. Read the code it touches and verify every existing path, function and signature you mention.

Dependencies may not be built yet: do not wait for them or look for their code in other branches or worktrees. Read each with the board tool `ticket_show` (and its story file), use the files, names and signatures its plan specifies, mark them "provided by T-NNN (not yet merged)", and list the exact interfaces you rely on in one place. If a prerequisite fixes no interface you need, state your assumption.

UI story with a mockup: view the image, keep its repository path and the story's screen regions, and turn the design into concrete layout, spacing, typography, colour and control details. Do not use sample values in the image as live data. If you cannot view it, say so and keep the reference rather than inventing details.

Replace the ticket body with the board tool `ticket_update` (mode "replace", the key from TASK). Keep the goal, acceptance criteria and any `Story file:` line at the top, then add:
1. Files to create or change, in order, with the functions or classes, their signatures and the behaviour of each step.
2. Data shapes, error and edge cases, with exact values or messages.
3. Tests to add: file, test name, input and expected result; at least one per acceptance criterion. Unit and integration tests only.
4. Anything the developer must not touch.
5. "Done when": only items a named test or command proves (unit or integration tests, `npm test`, `npm run typecheck`, `npm run build`). Anything that needs a person (launching the app, live providers) goes under "Operator checks" and never gates the ticket. Never require screenshots, captures or other recorded evidence.
Leave no design decision open. Do not edit files or write the implementation.

Pass once the ticket body is updated. Fail only when the story needs an operator decision (questions in findings; do not update the ticket).

Shell: read-only, one simple command at a time (`git log`, `git status`, `rg PATTERN`, `ls`, `cat FILE`). No `cd`, `&&`, `;`, pipes, loops or `find`; a denied command pauses the whole run. Read files with your file tools. Do not look at other tickets' branches or worktrees.

{{task}}
