ADD TESTS for the ticket. TASK is the ticket; the developer's work is committed on this branch (`git log main..HEAD --stat`, `git diff main...HEAD`).

For every acceptance criterion and edge case with no test or only a weak one, add tests in the project's style (backend: tests/, app: app/test/; unit tests where possible, integration tests only where the ticket needs them). Change only test files and fixtures, never production code, even if you find a bug: the verdict stage reports it.

Do not delete, reinstall or rebuild dependencies (if broken, request a fix from DELEGATED_COMMANDS and end your turn), and do not run git commands that change history or the working tree: the coordinator commits your work.

Finish with the tests you added and any quick checks you ran.

{{delegated_commands}}

{{task}}
