RESOLVE A MERGE CONFLICT for this ticket. The coordinator merged the base branch into the ticket worktree; files listed in TASK or by `git status` may contain conflict markers.

Read the ticket, its story or planning files, both sides of every conflict and the surrounding code. Keep the intent of the ticket branch and the compatible changes from the base branch, and remove every `<<<<<<<`, `=======` and `>>>>>>>` marker. Change nothing else (no new features, redesign or scope change), and do not merge, commit or reset: the coordinator commits this round and retries the merge after you pass.

If your commands allow it, run narrow checks that the resolved files parse or compile; otherwise review the resolved diff carefully. Pass only when no markers are left and the worktree is consistent. Fail with precise findings when the two sides cannot be reconciled without an operator decision.

{{task}}
