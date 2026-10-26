RESOLVE A MERGE CONFLICT for this ticket. The coordinator has synchronized the base branch into the preserved
ticket worktree. Files listed in TASK or by `git status` may contain conflict markers.

Read the ticket, its story or planning files, both sides of every conflict, and the surrounding code. Resolve only
the merge conflict: preserve the intent already implemented on the ticket branch and compatible changes from the
base branch. Remove every `<<<<<<<`, `=======`, and `>>>>>>>` marker. Do not add unrelated features, redesign the
implementation, change ticket scope, or merge/commit/reset Git history yourself; the coordinator commits this round
and retries the configured merge action after you pass.

Run the narrow checks needed to prove the resolved files parse or compile when your command policy permits it. If
tests cannot run, inspect the resolved diff carefully. Verdict `pass` only when all conflict markers are gone and the
worktree is internally consistent. Verdict `fail` with precise findings when intent cannot be reconciled without an
operator decision.

{{task}}
