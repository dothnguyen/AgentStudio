Implement the work described in TASK. If it names a story file, read it first, follow its "Implement in this order" steps, and make every "Done when" item true. Add unit tests in tests/unit for the new behaviour, then run the unit suite (`python3 -W ignore -m unittest discover -s tests/unit -t .`) and fix failures before you finish. Do not run git commands that change history or the working tree (no commit, reset, stash, checkout, clean). Do not mark the story Done and do not edit its Status line; the team lead does that after review.

If FINDINGS lists problems from an earlier review, fix those blockers (ignore suggestions) and change only what they need.

This is attempt {{visit}} of stage {{stage}}.

{{task}}
{{findings}}
