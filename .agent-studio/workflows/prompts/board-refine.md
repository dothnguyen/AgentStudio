REFINE ONE STORY so that a developer on a less capable model can implement it without having to reason about design. TASK is the story (the ticket you are working; its key is on the first line).

Read the story (if the ticket body has a `Story file:` line, read that file too: it holds the full story), then the code it touches in the current checkout, and verify every path, function name and signature you mention that already exists.

Stories this one depends on may not be built yet, and you must not wait for them or look for their code (not in other branches or worktrees either). Plan against what they will provide: read each prerequisite with the board tool `ticket_show` (its story, and its refined plan if it has one) and its story file, and use the files, names and signatures that plan specifies. Mark each such dependency in your plan as "provided by T-00N (not yet merged)", and put the exact interface you rely on in one place so the developer can check it against the merged code. If a prerequisite has no plan yet and its story does not fix an interface you need, write the assumption you made explicitly in the plan instead of leaving it open. Then replace the ticket body with the refined story using the board tool `ticket_update` (mode "replace"; use the key from TASK). Keep the original goal, acceptance criteria and any `Story file:` line at the top, then add:
1. Exact files to create or change, and for each: the functions or classes to add or change, with signatures and the behaviour of each step, in the order to do them.
2. Data shapes, error cases and edge cases, with the exact values or messages expected.
3. The tests to add: file names, test names, the input and the expected result of each, one per acceptance criterion at least.
4. Commands to run to check the work (the project's test commands) and anything the developer must not touch.
5. A "Done when" checklist in two parts. "Automated": items the workflow can verify by running tests (unit, integration, `npm test`, `npm run typecheck`, `npm run build`), each naming the test or command that proves it. "Operator checks": anything that needs a person on a real machine (launching the app on Windows, a live run with real providers). The board cannot do those, so keep them out of the automated list and never make them a condition for the story to pass.
Be concrete and complete; do not leave design decisions open. Do not edit files and do not write the implementation itself.

Verdict "pass" once the ticket body is updated. Verdict "fail" only when the story cannot be refined without a decision from the operator (put each question in findings; do not update the ticket).


Command rules: your shell is read-only and accepts only single simple commands (for example `git diff main...HEAD`, `git status`, `git log`, `rg PATTERN`, `ls`, `cat FILE`). Run one command at a time: no `cd`, `&&`, `;`, pipes, loops or `find`; a denied command pauses the whole run. Read files with your file tools, and do not inspect other tickets' branches or worktrees.

{{task}}
