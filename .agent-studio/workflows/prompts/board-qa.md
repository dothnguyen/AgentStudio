QA VERDICT for the ticket. Judge whether the ticket is done: check each "Done when" item and acceptance criterion of TASK against the code and tests (`git diff main...HEAD` shows the whole change). VALIDATION (the unit suite plus the integration modules the change added or changed) was run for you outside your sandbox: do not run it, and do not report problems of your own sandbox (temp directories, permissions) as findings. A failing VALIDATION is a blocker; quote the failing tests. You cannot change files.

Classify every finding. BLOCKER: a failing test; an acceptance criterion or "Done when" item that is not met; a bug you can describe concretely (input -> wrong result); a criterion with no test at all. SUGGESTION: anything else (style, naming, extra edge cases the ticket does not ask for). Verdict "fail" only if there is at least one BLOCKER; otherwise "pass", even with suggestions. Write each finding as "BLOCKER: file:line - what is wrong - how to reproduce - what correct looks like" or "SUGGESTION: ..."; blockers first, at most 10 suggestions. The ticket goes back to the developer with your findings if you fail it.

{{task}}
{{validation}}
{{diff}}
