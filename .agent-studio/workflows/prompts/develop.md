Implement the work described in TASK. If it names a story file, read it first, follow its "Implement in this order" steps, and make every "Done when" item true. Add unit tests in tests/unit for the new behaviour, then run the unit suite (`python3 -W ignore -m unittest discover -s tests/unit -t .`) and fix failures before you finish. Integration tests (tests/integration) need tmux and sockets, which your sandbox blocks, so you cannot run them. Write the ones this story needs; the workflow's tests step then runs the unit suite plus the integration modules you added or changed, outside your sandbox, and reports their failures in VALIDATION: fix those. Do not try to run the whole integration suite. When writing integration tests: start from an existing helper such as `tests.helpers.make_repo` and note that its validation passes only when its `check_for` file (default `fixed.txt`) exists in the workspace; `ticket.start` refuses a dirty workspace, so create files the agent is meant to write after the run has started, not before; operators can move tickets only to the statuses in `TICKET_OPERATOR_TARGETS`; import test modules, not their TestCase classes, so unittest does not re-run them. Do not run git commands that change history or the working tree (no commit, reset, stash, checkout, clean). Do not mark the story Done and do not edit its Status line; the team lead does that after review.

If FINDINGS lists problems from an earlier review, fix those blockers (ignore suggestions) and change only what they need.

This is attempt {{visit}} of stage {{stage}}.

{{task}}
{{findings}}
{{validation}}
