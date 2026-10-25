ADD TESTS for the ticket. TASK is the ticket, with its implementation plan and "Done when" checklist; the developer's work is committed on this worktree's branch. See it with `git log main..HEAD --stat` and `git diff main...HEAD`.

For every acceptance criterion and edge case in the ticket that has no test (or only a weak one), add tests under tests/ in the project's style (unit tests where possible; integration tests only where the ticket needs them). Only add or change test files and test fixtures: do NOT change production code, even if you find a bug (the verdict stage after the tests run reports it). Do not run git commands that change history or the working tree: the coordinator commits your work. Finish with a short list of the tests you added.

{{task}}
