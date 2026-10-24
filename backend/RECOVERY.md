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
| agent `limit_reached` (a `USAGE_LIMIT` final report, event `board.limit_reached`) | the agent's provider reported its usage limit; it takes no work until reset | wait for the reset time (`agents.limitResetAt`), then `agent-studio board resume --workspace <ws> --agent <agentId>` (or `--all`) |
| `WORKTREE_NOT_REGISTERED` from `task direct` / `workflow start` | the requested `--workspace` is not the team's own workspace; ticket worktrees do not exist until the P04 board returns (S10) | run the work in the team's workspace (drop `--workspace`), or start a team on that workspace |

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

## The generic board (P04)

`agent-studio team run-board --team T` binds a running team to the workspace board (`.agent-studio/board.json`) and
claims tickets by its rules; `team stop-board` stops claiming while running work finishes. `board show` /
`board phase list` show where everything stands; every ticket change is a `ticket_events` row (`ticket show`).
`<KEY>` is a ticket like `T-004`, `<ID>` a phase slug like `default`.

| You see | Meaning | Command |
|---|---|---|
| `BOARD_CONFIG_INVALID` (from any board command) | `board.json` is invalid (statuses, rules, `leaseSeconds`, `baseBranch`) or `board rules check` failed | `agent-studio board rules check --workspace <ws>` lists every problem; fix `board.json`, then `team run-board` again |
| `BOARD_ALREADY_RUNNING` from `team run-board` | another team already runs this board | `team stop-board`, or wait; one team runs a board at a time |
| `TEAM_NOT_RUNNING` | no team is running on the workspace (or none is bound to the board) | `agent-studio team start --team T`, then `team run-board --team T` |
| `BOARD_STATUS_UNKNOWN` | that status is not configured on this board | `board show` for the configured statuses, then move with one of them |
| `TICKET_NOT_FOUND` | no ticket with that key in this workspace | `agent-studio ticket list --workspace <ws>` |
| `TICKET_TRANSITION_INVALID` | that move is not allowed: the ticket is already in the target status, terminal (`done`/`closed` kind) without `--force`, not blocked on `ticket unblock`, or not claimed on `ticket retry` | `ticket show --workspace <ws> <KEY>`, then `ticket move ... --to <status> [--force]` |
| `TICKET_BUSY` | the ticket is claimed by a member (its phase cannot change), or the run you asked to apply is still running | wait for the round to finish, or `ticket retry --workspace <ws> <KEY>` to clear a stuck claim |
| `TICKET_DEPENDENCY_CYCLE` | the dependency would make tickets wait for each other | `ticket show` both tickets and drop one edge (`ticket depend --remove KEY`) |
| `TICKET_ROLE_MISMATCH` | kept for rules that mismatch roles and members (not currently raised) | check `rules[].role` against `roles.json` with `board rules check` |
| `BOARD_RULE_MISSING` from applying a run | the ticket's status has no rule, so no outcome can be applied | `board rules check`; add a rule for that status or move the ticket by hand |
| `PHASE_NOT_FOUND` / `PHASE_EXISTS` | no phase with that slug / one already exists | `board phase list --workspace <ws>` |
| `PHASE_PROTECTED` | the default phase cannot be removed or closed | its name and description can still be edited |
| `PHASE_CLOSED` | a closed phase cannot be set current or receive tickets | `board phase reopen --workspace <ws> ID` first |
| `PHASE_NOT_EMPTY` | removing a phase that still holds tickets needs a target | `board phase remove --workspace <ws> ID --move-to OTHER` (an open phase) |
| ticket `blocked` (`!ROUND_LIMIT:<status>` or `!RUN_BLOCKED:<run>`) | a round limit was hit, or a run ended in a way with no `onBlocked` target | read the findings (`ticket show`), fix the cause, then `agent-studio ticket unblock --workspace <ws> <KEY>` (or raise `maxRounds` first) |
| ticket back in its queue, event `ticket.lease_expired` | its lease expired while the run was unsettled — a coordinator or runner death; the claim was released once and the run cancelled | nothing: the board claims it again. A late report of the cancelled run is ignored |
| ticket claimed for long, nothing happens | the run is stuck (paused, runner gone) and the lease has not expired | `agent-studio ticket retry --workspace <ws> <KEY>` releases the claim and cancels the run, or wait for the lease |
| agent `limit_reached`, event `board.limit_reached`, ticket released without a round | the provider reported `USAGE_LIMIT`; the member takes no work until reset | wait for the reset time, then `agent-studio board resume --workspace <ws> --member NAME` (or `--agent ID` / `--all`) |
| `MAIN_CHECKOUT_DIRTY` / `MAIN_CHECKOUT_WRONG_BRANCH` (`ticket.merge_held` events) | the coordinator-only merge waits: the main checkout is dirty or not on `baseBranch` | `git -C <ws> status --porcelain`, commit or stash, `git -C <ws> switch <baseBranch>`; the merge happens on the next pass |
| `MERGE_CONFLICT` (event `ticket.merge_conflict`, ticket back to the rule's `onFail`) | the ticket branch no longer merges into the base branch; nothing was committed and nothing left dirty | the fixing round starts from the conflict (`rules[].onFail` carries it), or move the ticket and resolve by hand |
| `WORKTREE_NOT_REGISTERED` from `task direct` / `workflow start` | the requested `--workspace` is neither the team's nor a worktree registered to a claimed ticket | run the work in the team's workspace, or let the board create the ticket's worktree |
| `WORKTREE_EXISTS` (event `ticket.claim_released`, reason `start_failed`) | a branch or worktree for that ticket already exists | `git -C <ws> worktree list` / `branch`; if leftover, `git -C <ws> worktree remove --force <path>` and `git -C <ws> branch -D <branch>`, then the board retries |

### Danger zones

- **The main checkout.** While the board runs, do not edit, commit or switch branches in `<ws>`: `main`-workspace
  rules and every `merge` action hold until it is clean again, on `baseBranch`.
- **Worktrees.** They live under the WSL state directory (`~/.local/state/agent-studio/worktrees/...`). Never move
  them or create them by hand; never put a worktree root on `/mnt/c`.
- **`leaseSeconds`.** A claim whose lease expires while its run is still unsettled is released and its run
  cancelled — exactly once. Set `leaseSeconds` comfortably above your longest expected run.
- **Changing the current phase** never interrupts running work: it finishes and its outcome is applied; only new
  claims use the new phase. Closing or removing the current phase falls back to the default phase.
- **Aborting a merge.** After a squash merge never use `git merge --abort`; the coordinator already ran
  `git reset --merge` when it recorded the conflict.
