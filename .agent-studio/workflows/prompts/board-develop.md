IMPLEMENT THE TICKET. TASK is the ticket: follow its implementation plan step by step and make every item of its "Done when" checklist true. If the ticket has "Findings" sections from an earlier QA or review round, fix those blockers first and change only what they need (ignore suggestions).

Add or update unit tests in tests/unit for every behaviour you change, then run the unit suite (`python3 -W ignore -m unittest discover -s tests/unit -t .`) and fix failures before you finish. Integration tests (tests/integration) need tmux and sockets, which your sandbox blocks, so you cannot run them; write the ones the ticket needs. The workflow's tests step then runs the unit suite plus the integration modules you added or changed, and, for any Node package you changed (a top-level folder with a package.json, such as app/), `npm ci`, `npm test` and `npm run typecheck`, all outside your sandbox, and reports their failures in VALIDATION: fix those. If your sandbox cannot install or run Node tools, write the code and tests anyway and let that step run them. Make sure the package defines `test` and `typecheck` scripts so the step has something to run. The testing rules in .agent-studio/workflows/prompts/develop.md (the paragraph about integration tests) apply here too.

Do not run git commands that change history or the working tree (no commit, reset, stash, checkout, clean): the coordinator commits your work. Do not edit the ticket. Keep the change focused; no unrelated refactors. Finish with a short summary of what you changed and how it is tested.

This is attempt {{visit}} of stage {{stage}}.

{{task}}
{{findings}}
{{validation}}
