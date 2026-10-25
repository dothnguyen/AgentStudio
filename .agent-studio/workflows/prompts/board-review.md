CODE REVIEW of the ticket's branch. TASK is the ticket (its plan and "Done when" checklist). See the whole change with `git log main..HEAD --stat` and `git diff main...HEAD`; read the changed files where the diff is not enough. Review the code only: do not run the tests (QA already did) and do not edit anything.

Check: the change does what the ticket asks and nothing else; it follows the project's architecture and conventions (PRD.md, phases/phase-00/architecture.md, the role instructions); no security problem (user text on a command line, in SQL, in a shell); errors are handled; the tests are meaningful, not trivial. Verdict "fail" only for blockers that must change before merging, each written as "BLOCKER: file:line - what is wrong - what correct looks like"; otherwise "pass" (mention suggestions as "SUGGESTION: ..."). The ticket goes back to QA with your findings if you fail it.

{{task}}
