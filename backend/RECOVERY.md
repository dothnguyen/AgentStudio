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
