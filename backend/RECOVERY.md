# Recovering from interruptions

Agent Studio never guesses. Anything it cannot prove ends in a visible state, and you settle it with one
command. Run `agent-studio snapshot --pretty` (or `task show` / `workflow show`) to see where things stand;
every decision below is also an event in `agent-studio events`.

## What happens on its own

| Situation | What you see | Why it is safe |
|---|---|---|
| CLI or Windows caller killed, response missed | the command answered `PENDING`, or nothing | retry with the **same** `--key` / `idempotencyKey`: you get the original receipt, never a second task |
| Coordinator killed or crashed, at any point | `health` shows it stopped | `agent-studio coordinator start` replays pending commands once, applies waiting reports once, redelivers only requests no worker ever saw, and reconciles everything else (see `runtime.json` → `startupReconciliation`) |
| Coordinator down while agents work | work keeps running in the panes | runners keep reporting into the inbox; reports are applied exactly once after restart |
| Runner died after saving its result | assignment settles from `result.json` | event `assignment.reconciled` with `source: result.json` |
| A malformed or foreign report arrives | event `assignment.report_rejected` | nothing changes; the real report still settles the work |
| A cancelled run ignores the cancel for 15 s | event `assignment.cancel_escalated` | only the recorded runner identity is killed; its provider dies with it |
| A `team stop` that was interrupted | next start: `orphanSessions` → `removed` | only when the team row proves ownership; anything else is `preserved` |

## What needs you

| You see | Meaning | Command |
|---|---|---|
| assignment `waiting_input` (`PERMISSION_DENIED`, `INPUT_REQUIRED`) | the provider was blocked by policy or asked a question headless mode cannot answer | `agent-studio assignment resolve --assignment <id> --action retry` (same policy), or `--action retry --policy workspace_write` to allow writes explicitly (recorded as `policyChange`), or `--action fail` / `--action cancel` |
| assignment `reconciling` (`RUNNER_GONE`, `RUNNER_NO_START`, `RUNNER_NEVER_STARTED`, contradictory evidence) | the attempt's outcome cannot be proven | inspect `~/.local/state/agent-studio/runs/<id>/` (stdout, stderr, meta), then `assignment resolve --action retry`, `fail`, or `cancel` |
| `PROCESS_STILL_RUNNING` from resolve | the old attempt may still be running | `agent-studio assignment cancel --assignment <id>`, then resolve |
| `AGENT_UNAVAILABLE` from resolve retry | the agent's pane is gone | `--action fail` or `--action cancel`; start a new team for new work |
| workflow `paused` | a stage failed, timed out, was blocked, returned no valid verdict, or validation could not run | `agent-studio workflow show --workflow <id>` → take the current stage's assignment → `assignment resolve --assignment <id> --action retry` resumes the workflow from that stage; `fail` / `cancel` ends it. `agent-studio workflow cancel --workflow <id>` also ends it |
| direct task `failed` (e.g. `TIMEOUT`, `PROVIDER_ERROR`) | final; nothing is uncertain | send it again: `agent-studio task direct ...` (resolve does not apply to finished work) |
| agent `offline`, pane `dead` | its tmux pane exited | its in-flight work becomes `reconciling` (resolve as above); `team stop` then `team start` for a fresh team |
| team `error`, `CLEANUP_INCOMPLETE` from `team stop` | the session's ownership marker or panes do not match, or a recorded process survived the bounded stop | nothing was touched. Inspect with `tmux -L agent-studio ls` and `tmux -L agent-studio list-panes -a`; if you are sure the session is yours, remove it yourself: `tmux -L agent-studio kill-session -t <session-id>`, then `team stop` again |
| `startupReconciliation.orphanSessions` → `preserved` | an Agent Studio-looking session with no team proving ownership | same as above: inspect, then remove it yourself if it is yours |

Retries create a **new** assignment (new ID, attempt + 1); the old one is closed as
`failed / SUPERSEDED_BY_RETRY`. A workflow stage keeps its role's policy (developer `workspace_write`, reviewer
`read_only`); a different policy is refused there.

## Workflow runs started from a definition (P01)

Every workflow run executes a frozen definition. `agent-studio workflow show --workflow <id>` shows the route it took
(`workflow_run.routed` events: `fromStage → toStage` with the outcome and the assignment that caused it), the stage
attempts with their `visit`, and `stepCount`. A restart at any moment gives exactly one next assignment and the same
routed chain as an uninterrupted run: routing and dispatch commit in one transaction, and a validator started by a
transaction that never committed is stopped (by its recorded identity) before the retried stage starts a new one.

| You see | Meaning | Command |
|---|---|---|
| run `paused`, code `MALFORMED_VERDICT` on a QA / lead stage | the stage finished without a valid verdict line | `assignment resolve --assignment <that stage's assignment> --action retry`. The stage runs again with the same prompt and the **same visit**: it uses no `maxVisits` and no `maxSteps` |
| run `paused`, code `TIMEOUT`, `PERMISSION_DENIED`, `PROVIDER_ERROR` | as for direct tasks | same command; `--action fail` ends the run `failed`, `--action cancel` ends it `cancelled` |
| run `paused`, code `VALIDATION_ERROR` / `VALIDATION_LOST` | the test command could not run, or its process vanished | `workflow cancel --workflow <id>`, fix `.agent-studio/workflow.json`, start again (validation stages have no assignment to resolve) |
| run `failed`, reason `qa visit limit 3 reached` / `step limit 16 reached` | a loop used up its bound | read the route and the last finding; fix the cause and start a new run |
| run `failed`, reason `workflow deadline reached` | `workflowDeadlineMs` passed; the active stage was cancelled | start again with a smaller task or a longer deadline |
| run `paused`, code `LEGACY_WORKFLOW_RUN` | the run was started by Agent Studio before the upgrade | `workflow cancel --workflow <id>`. Resolve is refused for it |
| `PROCESS_STILL_RUNNING` from resolve | the stage's runner is still alive | `assignment cancel --assignment <id>`, then resolve |

`workflow cancel` works in every phase: an active agent stage is cancelled, a running validator is killed by its
verified identity, and a paused run is ended and its agents freed.

## Board (P03)

The board runs tickets through its columns on its own (`agent-studio board run --workspace <ws>`, or `team.py board run`).
See where everything stands with `agent-studio board show --workspace <ws>` (or `team.py board`): the column, `!<blockedReason>`
on blocked tickets, `LIMIT:` lines for agents that hit a usage limit and `HELD:` lines for columns that wait. Every change is
also a `ticket.*` / `board.*` event (`agent-studio events`, `ticket show`). `<ws>` is the workspace path, `<KEY>` a ticket
like `T-004`. `scripts/live/board_drills.py --provider fake` replays the failures marked *drill* below on the fake provider.

### Failures (each one has a drill)

| You see | Meaning | Command |
|---|---|---|
| *drill `coordinator_killed`*: `health` shows the coordinator stopped while a ticket is `in_dev` | the coordinator died mid-ticket; the runner keeps working and reports into the inbox | `agent-studio coordinator start`. The report is applied once (one `ticket.outcome_applied` for that run) and the board carries on; `team.py board` shows it |
| *drill `runner_killed`*: ticket `blocked` `!RUN_PAUSED:...`, its assignment `reconciling` (`RUNNER_GONE`) | the runner process died, so the attempt cannot be proven | `agent-studio assignment resolve --assignment <id> --action retry` (the run continues and the ticket returns to its column), or `--action fail`, then `agent-studio ticket unblock --workspace <ws> <KEY>` |
| *drill `merge_conflict`*: ticket back in `changes_requested`, finding `MERGE_CONFLICT: <path>`, event `ticket.merge_conflict` | the branch no longer merges into the base branch | nothing: the next develop round starts with the base merged into the branch and the developer resolves the markers. If the ticket is stuck, `agent-studio ticket retry --workspace <ws> <KEY>` |
| *drill `round_limit`*: ticket `blocked` `!ROUND_LIMIT:test` (or `dev`, `review`) | the column's round limit (`roundLimits` in `.agent-studio/board.json`) was used up | read the findings (`team.py ticket show <KEY>`), raise the limit if needed, then `agent-studio ticket unblock --workspace <ws> <KEY>` (it returns to the queue it came from) or `agent-studio ticket cancel --workspace <ws> <KEY>` |
| *drill `planning_outside`*: ticket `blocked` `!PLANNING_DIFF_INVALID`, a stray file in the main checkout | a planning agent (unpack / triage / refine) wrote outside its allowed paths; nothing was committed and nothing was reverted | look with `git -C <ws> status --porcelain`, remove the stray file (`rm <ws>/<path>`, or `git -C <ws> stash push --include-untracked`), then `agent-studio ticket unblock --workspace <ws> <KEY>`. Until the checkout is clean the ticket waits (`HELD: refine MAIN_CHECKOUT_DIRTY`) |
| *drill `dirty_main`*: ticket waits in `ready_merge`, `HELD: merge MAIN_CHECKOUT_DIRTY` | the main checkout has uncommitted changes, so the merge is held | `git -C <ws> status --porcelain`, then `git -C <ws> stash push --include-untracked`, `git -C <ws> checkout -- <path>` or `rm <ws>/<path>`; the board merges on its next pass |
| *drill `usage_limit`*: ticket back in `ready_dev` with event `ticket.released` (`usage_limit`), `LIMIT: <agent> (Developer) until <time>` | the agent's provider reported a usage limit; the round was not counted and the agent takes no work | wait for the reset, then `agent-studio board resume --workspace <ws> --agent <agentId>` (or `--all`); `team.py board resume --agent <name>` |
| *drill `stuck_claim`*: ticket `in_dev` (or another working column) with a `ticket.claimed` event and no `ticket.run_started` after it | the coordinator died between claiming the ticket and starting its run; the lease (`leaseSeconds`) has not expired | `agent-studio ticket retry --workspace <ws> <KEY>` releases the claim (`ticket.released`, `operator_retry`) and the board claims it again. Without it the lease expiry does the same |

### Codes

| You see | Meaning | Command |
|---|---|---|
| `TICKET_NOT_FOUND` | no ticket with that key in this workspace | `agent-studio ticket list --workspace <ws>` or `team.py board` to find the key |
| `TICKET_TRANSITION_INVALID` | that move is not allowed from the ticket's status (operators may move only to `backlog`, `ready_unpack`, `ready_dev`, `ready_test`, `ready_review`, `refine`, `triage`, `fail_test`, `changes_requested`, `blocked`) | `agent-studio ticket show --workspace <ws> <KEY>`, then `agent-studio ticket move --workspace <ws> <KEY> --to <status>` to an allowed one, or `ticket cancel` |
| `TICKET_BUSY` | the ticket has an active run, so it cannot be moved | wait for the run, or `agent-studio ticket retry --workspace <ws> <KEY>` / `agent-studio assignment resolve --assignment <id> --action cancel` to end it |
| `TICKET_DEPENDENCY_CYCLE` | the dependency you added would make tickets wait for each other | `agent-studio ticket show --workspace <ws> <KEY>` and drop one dependency (`team.py ticket depend <KEY> --on <other>` only with an acyclic choice) |
| `STORY_PATH_INVALID` | the story path is not a file under the workspace, or is not the expected form | `team.py ticket add phases/phase-NN/stories/PNN-SMM-name.md` with a path that exists in the checkout |
| `BOARD_CONFIG_INVALID` | `.agent-studio/board.json` is broken or a column definition is wrong | `git -C <ws> diff -- .agent-studio/board.json`, fix or `git -C <ws> checkout -- .agent-studio/board.json`, then `agent-studio board run --workspace <ws>` |
| `WORKTREE_NOT_REGISTERED` | the ticket's worktree is not one Agent Studio created | never create worktrees by hand; `agent-studio ticket move --workspace <ws> <KEY> --to ready_dev` makes the board create a fresh one |
| `WORKTREE_EXISTS` | a branch or worktree for that ticket is already there | `git -C <ws> worktree list` and `git -C <ws> branch`; if it is a leftover, `git -C <ws> worktree remove --force <path>` and `git -C <ws> branch -D <branch>`, then `agent-studio ticket retry --workspace <ws> <KEY>` |
| `WORKTREE_MISSING` (ticket `!WORKTREE_MISSING`) | the ticket's worktree directory is gone | `agent-studio ticket unblock --workspace <ws> <KEY>` after `git -C <ws> worktree prune`; or `ticket cancel` and create the ticket again |
| `MAIN_CHECKOUT_DIRTY` (`HELD:` line) | uncommitted changes in the main checkout hold unpack, triage, refine and merge | `git -C <ws> status --porcelain`, then `git -C <ws> stash push --include-untracked`, `git -C <ws> checkout -- <path>` or `rm <ws>/<path>` |
| `MAIN_CHECKOUT_WRONG_BRANCH` (`HELD:` line) | the main checkout is not on `baseBranch` | `git -C <ws> switch <baseBranch>` (after stashing or committing your work) |
| `MAIN_CHECKOUT_BUSY` (`HELD:` line) | another planning or merge step is using the main checkout right now | nothing: it clears by itself. If it never clears, `agent-studio board show --workspace <ws>` and look for a ticket stuck in `unpacking` / `triaging` / `refining`, then `agent-studio ticket retry --workspace <ws> <KEY>` |
| `PLANNING_DIFF_INVALID` (ticket `!PLANNING_DIFF_INVALID`) | a planning agent's changes were outside its allowed paths, or mixed with yours | as in the `planning_outside` row: clean the checkout, then `agent-studio ticket unblock --workspace <ws> <KEY>` |
| `MANIFEST_INVALID` (ticket `!MANIFEST_INVALID`) | the unpacked manifest has errors; the questions are on the ticket | `team.py ticket show <KEY>`, fix the brief, then `agent-studio ticket unblock --workspace <ws> <KEY>` |
| `BUG_FILE_INVALID` (ticket `!BUG_FILE_INVALID`) | triage produced a bug file that does not parse | `agent-studio ticket unblock --workspace <ws> <KEY>` to triage again, or `agent-studio ticket move --workspace <ws> <KEY> --to triage` |
| `UNPACK_QUESTIONS` (ticket `!UNPACK_QUESTIONS`) | the product owner has open questions about the brief | answer them in the brief, then `agent-studio ticket unblock --workspace <ws> <KEY>` |
| `MERGE_CONFLICT` (finding `MERGE_CONFLICT: <path>`) | the squash merge into the base failed on that path | as in the `merge_conflict` row; `agent-studio ticket retry --workspace <ws> <KEY>` if it does not move on |
| `NO_CHANGES` (finding on a ticket sent back to `ready_dev`) | the developer finished without changing any file | `agent-studio ticket show --workspace <ws> <KEY>` and read the story; the next round starts by itself, or `agent-studio ticket block --workspace <ws> <KEY> --reason <text>` to stop it |
| `USAGE_LIMIT` | a provider reported its usage limit | `agent-studio board resume --workspace <ws> --agent <agentId>` after the reset time shown in `LIMIT:` |
| `TICKET_ROLE_MISMATCH` | the agent you named has a different role than the column | name an agent with the right role (`team.py board`, agents list) or let the board pick: `agent-studio board run --workspace <ws>` |
| `TICKET_DEPS_NOT_MERGED` | a dependency has not merged yet, so develop cannot start | wait; the board starts it after the dependency merges. To drop the wait: `team.py ticket add --no-deps`, or `agent-studio ticket cancel --workspace <ws> <KEY>` for the prerequisite |
| `TEAM_CONFIG_INVALID` | the roster in `.agent-studio/team.json` is wrong (for example two agents with the same name) | fix `.agent-studio/team.json`, then `agent-studio team start --workspace <ws>` (`team.py start`) |
| `RUN_PAUSED` (ticket `!RUN_PAUSED:<code>`) | the ticket's run paused (malformed verdict, timeout, permission, lost runner) | `agent-studio assignment resolve --assignment <id> --action retry`, or `agent-studio ticket unblock --workspace <ws> <KEY>` to run the column again |
| `ROUND_LIMIT` (ticket `!ROUND_LIMIT:<column>`) | the round limit for that column was reached | `agent-studio ticket unblock --workspace <ws> <KEY>` or `ticket cancel`; see the `round_limit` row |
| `VERDICT_FAIL` (ticket `!VERDICT_FAIL:<column>`) | a planning column's verdict was *fail*; the findings are on the ticket | `team.py ticket show <KEY>`, fix the cause, then `agent-studio ticket unblock --workspace <ws> <KEY>` |
| `RUN_FAILED` (ticket `!RUN_FAILED`) | the column's run failed outright | `agent-studio ticket show --workspace <ws> <KEY>`, then `agent-studio ticket unblock --workspace <ws> <KEY>` to try again, or `ticket cancel` |
| `OUTCOME_UNSUPPORTED` (ticket `!OUTCOME_UNSUPPORTED`) | the run ended in a way the board cannot apply | `agent-studio ticket show --workspace <ws> <KEY>`, then `agent-studio ticket unblock --workspace <ws> <KEY>` or `ticket cancel` |
| `START_FAILED` (event `ticket.released`, reason `start_failed`) | the run could not be started and the claim was given back | fix the cause named in the event (agent, workspace, definition), then `agent-studio board run --workspace <ws>` |

### Danger zones

- **The main checkout.** While the board runs, do not edit, commit or switch branches in `<ws>`. The board holds unpack, triage,
  refine and merge as `MAIN_CHECKOUT_DIRTY` / `MAIN_CHECKOUT_WRONG_BRANCH` until it is clean again. If your edits are mixed with a
  planning agent's, the ticket is blocked `PLANNING_DIFF_INVALID`: nothing is committed and nothing is reverted, so sort out
  your files with `git -C <ws> status --porcelain` before `ticket unblock`.
- **Worktrees.** They live under the WSL state directory (`~/.local/state/agent-studio/...`). Never move them, never create
  worktrees by hand (`WORKTREE_EXISTS`, `WORKTREE_NOT_REGISTERED`), and never put a worktree root on `/mnt/c`: it is slow
  and Windows tools lock files there.
- **Aborting a merge.** After a squash merge never use `git merge --abort` (there is no merge to abort); use
  `git reset --merge` in the affected checkout.
