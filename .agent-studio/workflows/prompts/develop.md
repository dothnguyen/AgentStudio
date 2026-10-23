Implement the work described in TASK. If it names a story file, read it first, follow its "Implement in this order" steps, and make every "Done when" item true. Add unit tests in tests/unit for the new behaviour, then run the unit suite (`python3 -W ignore -m unittest discover -s tests/unit -t .`) and fix failures before you finish. Integration tests (tests/integration) need tmux and sockets that your sandbox may not allow: write them, try to run the ones you touched, and if they cannot run because of the sandbox say so plainly (do not count that as a failure to fix, and do not claim them verified). The validation step runs the integration tests you added or changed outside your sandbox and its result is what counts. Do not run git commands that change history or the working tree (no commit, reset, stash, checkout, clean). Do not mark the story Done and do not edit its Status line; the team lead does that after review.

If FINDINGS lists problems from an earlier review, fix those blockers (ignore suggestions) and change only what they need.

This is attempt {{visit}} of stage {{stage}}.

{{task}}
{{findings}}
{{validation}}
