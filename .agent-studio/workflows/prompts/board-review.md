CODE REVIEW of the ticket's branch. TASK is the ticket. See the change with `git log main..HEAD --stat` and `git diff main...HEAD`; read changed files where the diff is not enough. QA already had the suite run and passed it. Do not edit anything and never run tests in your sandbox; if you need evidence for a suspected defect, request the narrowest delegated run that covers it (DELEGATED_COMMANDS) and end your turn.

Earlier QA and review findings in TASK are history. Report an old failure as a blocker only if current evidence shows it still fails or you find the defect in the code now; a newer passing run supersedes it. If current evidence is missing, say so.

Check: it does what the ticket asks and nothing else; it follows the project's architecture and conventions (PRD.md, phases/phase-00/architecture.md, the role instructions); no security problem (user text in a command line, SQL or shell); errors are handled; the tests are meaningful. Fail only for blockers that must change before merging: "BLOCKER: file:line - what is wrong - what correct looks like". Otherwise pass, with "SUGGESTION: ..." lines if useful.

Shell: read-only, one simple command at a time (`git diff main...HEAD`, `git log`, `git status`, `rg PATTERN`, `ls`, `cat FILE`). No `cd`, `&&`, `;`, pipes, loops or `find`; a denied command pauses the whole run. Read files with your file tools. Do not look at other tickets' branches or worktrees.

{{task}}
{{delegated_commands}}
