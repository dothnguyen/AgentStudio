# Phase 03 — Asynchronous ticket board (kanban)

> Status: Planned, rev 1 (2026-10-22)
> Brief: [feature-kanban-board.md](../briefs/feature-kanban-board.md) (decisions recorded 2026-10-22, §9)
> Product: [PRD.md](../../PRD.md) · Delivery: [ROADMAP.md](../../ROADMAP.md) · Stories: [stories/README.md](./stories/README.md)
> Builds on: [P00 implementation contract](../phase-00/architecture.md), [P01 design contract](../phase-01/README.md#design-contract)

## Goal

Today the operator drives one story at a time with `team.py run story-delivery --story S` and waits. This phase adds a **board**: durable tickets (features, stories, bugs) move through columns, and idle agents **pull** work by role, in parallel, each story ticket on its own branch and git worktree, while the coordinator alone does every git operation, including the squash merge into the base branch.

Backend and CLI only. P02 will render `board.show` later. This phase adds no UI.

## Open questions and the assumptions this plan uses

| # | Question | Assumption until answered |
|---|---|---|
| Q1 | ROADMAP lists P03 as "Reusable teams" and P04 as "parallel work isolation (per-agent worktrees)". The PRD lists "project/backlog database" as a non-goal. | The board is planned as **phase 03** because the task asks for it. PRD and ROADMAP need a rev-4 note from the operator, which this plan does not write. The board is a *work queue for agents*, not a product backlog: it does not add estimates, sprints, users or reporting. |
| Q2 | Brief §4 gives `tickets.team_id`. But a team gets new IDs on every `team.start`, so tickets would be orphaned by a team restart. | **A board belongs to a workspace** (the canonical main-checkout path), not to a team. Tickets carry `workspace`. The scheduler offers them to the running team on that workspace (at most one, as today). A team restart loses nothing. |
| Q3 | The review stage is `read_only` (decision 3), so the lead cannot set `Status: Done` or fill Evidence as it does today. | The **developer** fills the Evidence section and ticks the "Done when" items it proves, on the branch. QA and the lead check them. At merge, the coordinator rewrites only the `Status:` line to `Done (YYYY-MM-DD)` in the squashed tree, a mechanical one-line edit. |
| Q4 | A P01 run **pauses** on a failed or uncertain agent result or a malformed verdict. What does the ticket do? | The ticket goes to `blocked` with `blocked_reason = RUN_PAUSED:<code>` and the run ID. The paused run keeps holding its worktree. The operator resolves the run (`assignment.resolve`); a run that then finishes is applied normally. Or the operator cancels it and runs `ticket.unblock`. `USAGE_LIMIT` is the exception (§H). |
| Q5 | The lead's `pass` has no ```` ```commit ```` block. | The merge still happens, with the default message `<key>: <title>`, and a `ticket.merge_message_defaulted` warning event. Blocking a passed review over the message wastes a round. |
| Q6 | Delete the branch after the squash merge? | No. The worktree is removed; the branch is kept (its content is in base and its head is recorded on the ticket). Branch cleanup is a later operator command, outside this phase. |
| Q7 | `board.require_bug_approval` (§9.00) and the `needs_split` loop (§9.0)? | Bug approval stays **off and is not built** (the operator can edit the bug file or move the ticket back to `triage`). `needs_split` is a follow-up after this phase. |
| Q8 | The developer stage reruns tests itself. Is the deterministic validation command part of the `develop` column? | Yes. The `board-develop` definition is `develop` → `tests` (validation, `fail` → `develop`, `maxVisits` 3). The coordinator commits the round only when the run succeeds. |
| Q9 | P01-S04 and P01-S10 are still `To Do` in the P01 table, while S05–S09 are Done. | The board needs the P01 engine (S01–S09) to work as built. S04's status looks stale, which the operator should confirm. The P01 live gate (S10) does not block P03 development, but it must pass before the P03 gate (S17). |

## Epics → stories

| Epic | Story | Deliverable |
|---|---|---|
| A Foundations | [P03-S01](./stories/P03-S01-ticket-store-and-states.md) | Schema v7 (`tickets`, `ticket_deps`, `ticket_events`), statuses, transition table |
| | [P03-S02](./stories/P03-S02-ticket-commands.md) | `ticket.create/show/list/move/block/unblock/cancel/depend`, `Depends on:` parsing, CLI + `serve` |
| | [P03-S03](./stories/P03-S03-worktree-service.md) | `worktrees.py`: create/list/remove/reconcile, commit-on-branch, planning commits, path safety |
| | [P03-S04](./stories/P03-S04-per-run-workspace.md) | `workflow.start` / `task.direct` take a registered worktree; per-path lock; role context from the worktree |
| B Column pipelines | [P03-S05](./stories/P03-S05-board-config-and-columns.md) | `board.json`, built-in column definitions and prompts, run seeds, manual `ticket.start` |
| | [P03-S06](./stories/P03-S06-outcome-applier.md) | Run end → transition, findings, round counters and limits, develop commit, refine planning commit |
| | [P03-S07](./stories/P03-S07-merge-step.md) | `ready_merge`, squash merge under the main-checkout lock, conflicts, unblocking dependents |
| | [P03-S08](./stories/P03-S08-bug-tickets-and-triage.md) | `bug` kind, `team.py bug`, `triage` column, bug template and validator, bug prompts, severity |
| | [P03-S09](./stories/P03-S09-product-owner-and-manifest.md) | ProductOwner role, `board-unpack` definition, `tickets.json` manifest validator |
| | [P03-S10](./stories/P03-S10-unpack-outcome-and-children.md) | Unpack outcome: planning commit, child tickets, questions, re-unpack, parent `done`, plan gate |
| C Scheduler | [P03-S11](./stories/P03-S11-usage-limits.md) | `USAGE_LIMIT` classification, agent `limit_reached`, `board.resume` |
| | [P03-S12](./stories/P03-S12-leases-and-recovery.md) | Lease expiry, release on crash/timeout/restart, orphan worktrees, `ticket.retry` |
| | [P03-S13](./stories/P03-S13-scheduler-picker.md) | Board tick: priorities, dependencies, `maxParallelDev` + blocker slot, `board.run/pause` |
| | [P03-S14](./stories/P03-S14-multi-agent-rosters.md) | Several agents per role, binding by availability, one assignment per agent |
| D Operator experience | [P03-S15](./stories/P03-S15-board-show-and-team-py.md) | `board.show`, `team.py board`, `team.py ticket add/move`, limit lines |
| | [P03-S16](./stories/P03-S16-recovery-doc-and-drills.md) | Recovery doc and failure drills |
| Gate | [P03-S17](./stories/P03-S17-live-gate.md) | Real providers on a throwaway repo: 3 tickets, one dependency, one forced QA fail |

Order: S01 → S02 → S03 → S04 → S05 → S06 → (S07, S08, S09 in parallel) → S10 → (S11, S12 in parallel) → S13 → S14 → S15 → S16 → S17. S03 can start beside S01/S02 (pure git). S15 can start as soon as S12 is done.

Value: after S04, two stories can already run in parallel by hand (two worktrees, `workflow.start --workspace`). After S07, the whole column pipeline runs by hand with `ticket.start`. After S13, it runs on its own.

## Design contract

Every P03 story targets this section as its "Architecture". It extends the P00 and P01 contracts, and everything there still holds: the coordinator is the only writer of state and events, the CLI writes only to the command inbox, runners write only to the report inbox, there is no shell for user text, and the permission vocabulary is unchanged. A story that changes a rule here updates this section in the same change.

### A. Board scope and configuration

- One board per **workspace** (the canonical main-checkout path from `ops.canonical_workspace`), see Q2. Ticket keys are `T-001`, `T-002`, … per workspace, one sequence for every kind.
- Configuration: `<workspace>/.agent-studio/board.json` (optional; every key has a default), read and validated at `board.run` and frozen until the next `board.run` (`BOARD_CONFIG_INVALID` with `{path, message}` errors, the same shape as P01 §B). Until a `board.run` has frozen one, `ticket.start` and the outcome applier read the file each time (`board_config.current`, S05). A present file is merged over the defaults key by key; unknown keys are errors. With a team given, a column **written in the file** whose role no agent has is an error; a default column nobody staffs is only listed as `unstaffed`. The defaults ship as `backend/agent_studio/board_defaults.json`, and the column table (queues, working status, workspace, seed kind per column) is `schema.BOARD_COLUMNS`, so board code itself names no role or column. The keys:

```json
{
  "version": 1,
  "baseBranch": "main",
  "maxParallelDev": 2,
  "roundLimits": {"dev": 3, "test": 3, "review": 3},
  "leaseSeconds": 120,
  "requirePlanApproval": false,
  "columns": {
    "unpack":  {"role": "ProductOwner", "definition": "board-unpack"},
    "triage":  {"role": "TeamLead",     "definition": "board-triage"},
    "refine":  {"role": "TeamLead",     "definition": "board-refine"},
    "develop": {"role": "Developer",    "definition": "board-develop", "bugDefinition": "board-develop-bug"},
    "test":    {"role": "QA",           "definition": "board-test",    "bugDefinition": "board-test-bug"},
    "review":  {"role": "TeamLead",     "definition": "board-review",  "bugDefinition": "board-review-bug"}
  }
}
```

- `definition` names a P01 definition: a built-in (`backend/agent_studio/workflows/<name>.json`; the built-in loader reads `.json` only) or a workspace file. Each column definition uses exactly one agent role, which `ticket.start` binds to the claiming agent. Roles come **only** from this file. Board code never names a role, a stage id or a provider (the P01 guard test is extended to `board*.py`, `tickets.py`, `worktrees.py`).

### B. Tickets: data and statuses

Schema **v7** (`state.MIGRATIONS[7]`, the same migrate helper, `PRAGMA foreign_key_check` after it):

- `tickets`: `id`, `workspace`, `key` (unique per workspace), `kind` (`feature`|`story`|`bug`), `title`, `story_path` (story; bug after triage), `brief_path` + `out_dir` (feature), `raw_text` (bug intake), `attachments_json`, `severity` (`blocker`|`major`|`minor`|NULL), `duplicate_of`, `parent_ticket_id`, `status`, `return_status` (when `blocked`), `blocked_reason`, `priority` (integer, lower first; default 100), `branch`, `worktree_path`, `base_commit`, `head_commit`, `merged_commit`, `assignee_agent_id`, `lease_until`, `run_id` (current column run), `applied_run_id` (last run whose outcome was applied), `dev_rounds`, `test_rounds`, `review_rounds`, `findings_json` (latest findings for the developer), `questions_json`, `created_at`, `updated_at`.
- `ticket_deps (ticket_id, blocked_by_ticket_id)`, primary key on both columns, no self-edge, acyclic (checked by the command, `TICKET_DEPENDENCY_CYCLE`).
- `board_state (workspace PK, status running|paused, reason, config_json, review_streak)` and `board_locks (workspace, name, ticket_id, created_at, PK (workspace, name))`. These are created in v7 and used by S07 and S13.
- `ticket_events (id INTEGER PK AUTOINCREMENT, ticket_id → tickets, event_seq → events(seq), at, actor, name, from_status, to_status, payload_json)`: append-only (the `_immutable` triggers). Every ticket write also writes one row to the existing `events` stream (`events.after`), with `ticket.*` / `board.*` names and the ticket ID and key.

Statuses (`backlog` is the entry status when `requirePlanApproval` holds a child; see S10):

| Kind | Path |
|---|---|
| feature | `backlog` → `ready_unpack` → `unpacking` → `unpacked` → `done` |
| story | `backlog` → `refine` → `refining` → `ready_dev` → `in_dev` → `ready_test` → `in_test` → `ready_review` → `in_review` → `ready_merge` → `merged` |
| bug | `triage` → `triaging` → `ready_dev` → … same as story … → `merged` |
| loops | `in_test` → `fail_test` → `in_dev`; `in_review` / `ready_merge` → `changes_requested` → `in_dev` |
| any kind | any non-terminal → `blocked` (stores `return_status`) → back; any non-terminal → `cancelled` |

Terminal: `merged`, `done`, `cancelled`. The allowed transitions are one table, `schema.TICKET_TRANSITIONS` (from, to, actor = `coordinator` | `operator`), next to the other entity tables in `schema.py` (the single source for CHECKs and validation); `tickets.py` uses it as `tickets.TRANSITIONS`. Anything else → `TICKET_TRANSITION_INVALID`. The `in_*` / `*ing` statuses, `ready_merge`, `merged`, `unpacked` and `done` are entered **only** by the coordinator. The operator (`ticket.move`) may move a ticket with no active run to `backlog`, `ready_unpack`, `ready_dev`, `ready_test`, `ready_review`, `refine`, `triage`, `fail_test`, `changes_requested` or `blocked`. A ticket with an active run → `TICKET_BUSY` (cancel the run first, or use `ticket.cancel`).

The table, exactly (S01 builds it from these rules; "working" = `unpacking`, `refining`, `triaging`, `in_dev`, `in_test`, `in_review`; each has the queue it is picked from: `ready_unpack`, `refine`, `triage`, `ready_dev`|`fail_test`|`changes_requested`, `ready_test`, `ready_review`):

| Rows | Actor |
|---|---|
| Claim: each queue → its working status (`ready_unpack→unpacking`, `refine→refining`, `triage→triaging`, `ready_dev`/`fail_test`/`changes_requested→in_dev`, `ready_test→in_test`, `ready_review→in_review`) | coordinator |
| Release: each working status → each queue it can be picked from (the reverse of every claim row) | coordinator |
| Outcomes: `unpacking→unpacked`, `unpacked→done`, `refining→ready_dev`, `triaging→ready_dev`, `in_dev→ready_test`, `in_test→ready_review`, `in_test→fail_test`, `in_review→ready_merge`, `in_review→changes_requested`, `ready_merge→merged`, `ready_merge→changes_requested` | coordinator |
| Plan gate: `backlog→refine` (`ticket.approve`, S10) | coordinator |
| Late outcome: `blocked` → `unpacked`, `ready_dev`, `ready_test`, `fail_test`, `ready_review`, `changes_requested`, `ready_merge` (a paused run that finishes after the ticket was blocked, S06) | coordinator |
| Move: every non-terminal status except `blocked` → every operator target above (to ≠ from) | operator |
| Block: every non-terminal status except `blocked` → `blocked` | both |
| Unblock: `blocked` → its stored `return_status` (a restore, so it is allowed even when that status is coordinator-only) | both |
| Cancel: every non-terminal status → `cancelled` | both |

A transition is also refused when `from` or `to` is not on the ticket's kind path (`KIND_STATUSES`): feature = `backlog, ready_unpack, unpacking, unpacked, done`; story = `backlog, refine, refining, ready_dev, in_dev, ready_test, in_test, ready_review, in_review, ready_merge, merged, fail_test, changes_requested`; bug = the story set without `backlog, refine, refining`, plus `triage, triaging`; every kind also has `blocked` and `cancelled`. `block` stores `return_status` = the current status, except that a working status stores its `ready_*`/queue column (`in_dev` → `ready_dev`, `refining` → `refine`, …), so `return_status` is never a working status (S06 relies on this). The coordinator may pass an explicit `return_status` (a non-working, non-terminal status on the kind path); an outcome that blocks stores the status it would have entered, e.g. `ROUND_LIMIT:test` → `fail_test` (S06). Leaving `blocked` by any path (unblock, late outcome, cancel) clears `return_status` and `blocked_reason`. The `TICKET_BUSY` rule applies to operator move, block and unblock, never to cancel.

### C. Columns, runs and outcomes

- Each column visit is **one P01 workflow run**, started by the coordinator with the column's definition, bound to the claiming agent (`bindings {role: agentId}`), in the column's workspace:

| Column | Picks from | Workspace | Permission |
|---|---|---|---|
| unpack | `ready_unpack` | main checkout | `workspace_write` (planning files only, §F) |
| triage | `triage` | main checkout | `workspace_write` (bug file only, §F) |
| refine | `refine` | main checkout | `workspace_write` (planning files only, §F) |
| develop | `ready_dev`, `fail_test`, `changes_requested` | ticket worktree | `workspace_write` |
| test | `ready_test` | ticket worktree | `read_only` |
| review | `ready_review` | ticket worktree | `read_only` |

- **Run seeds.** `workflow.start` gets an internal (coordinator-only, not on the CLI) `seed {findings?, diff?}`. It fills `{{findings}}` / `{{diff}}` of the run's **first** stage; later stages get what the run produced, and the seed is not stored on the run. The `dispatch` validators reject a `seed` key (`BAD_REQUEST`). For develop the seed is the ticket's `findings_json`. For test and review the seed is the branch diff `git diff <merge-base(baseBranch, branch)> <branch>`. The run's `{{task}}` is composed by the board: key, kind, title, story/bug path, and for bugs the raw text.
- **Outcomes** (applied once per run, idempotent through `applied_run_id`):

| Column | Run end | Ticket |
|---|---|---|
| any | paused (agent failure, malformed verdict, validation error) | `blocked`, `RUN_PAUSED:<code>` (Q4) |
| any | cancelled | back to the column it was picked from, lease released |
| any | assignment `failed` with `USAGE_LIMIT` | run cancelled, back to the column it was picked from, no round counted (§H) |
| unpack | `succeeded`, valid manifest, empty `questions` | planning commit; children created (S10); parent `unpacked` |
| unpack | `succeeded` with `questions`, or verdict `fail` | `blocked` with the questions; nothing committed except a valid planning diff |
| triage | verdict `pass`, valid bug file | planning commit; `story_path`, `severity`, priority (§G); `ready_dev` |
| triage | verdict `pass`, bug file names `Duplicate of: T-NNN` | planning commit; `cancelled` with `duplicate_of` |
| triage | verdict `pass`, missing or invalid bug file | planning commit if the path is allowed; `blocked` / `BUG_FILE_INVALID`, the `{section, message}` errors as questions |
| triage | verdict `fail` | `blocked` with the findings as questions (bug file still committed if its path is allowed) |
| refine | verdict `pass`, valid planning diff | planning commit; `ready_dev` |
| refine | verdict `fail` | `blocked` with the findings as questions (planning diff still committed if valid) |
| develop | `succeeded` | commit on branch; `ready_test` |
| develop | `failed` (bounds) | `dev_rounds` + 1; over the limit → `blocked`, else `ready_dev` with the validation output as findings |
| test | `pass` | `ready_review` |
| test | `fail` | `test_rounds` + 1, findings stored; over the limit → `blocked`, else `fail_test` |
| review | `pass` | `ready_merge`; the ```` ```commit ```` message goes into the `ticket.outcome_applied` payload as `commitMessage` (S07) |
| review | `fail` | `review_rounds` + 1, findings stored; over the limit → `blocked`, else `changes_requested` |
| merge | conflict | `changes_requested`, findings `MERGE_CONFLICT: <path>` (counts as a review round; over the limit → `blocked`) |

"Over the limit" means the counter would exceed `roundLimits.<column>` (default 3).

- The rows are data, `schema.BOARD_OUTCOMES` (per column: `kind` work|verdict, `pass`/`fail` targets, `counter`, `limit` key, `commit` branch|planning|none, planning `globs`), next to `BOARD_COLUMNS`, so board code names no column (S06; S08/S10 add `triage`/`unpack`). Block reasons: `RUN_PAUSED:<code>` (the `diagnosticCode` of the run's latest `workflow_run.paused` event, else `UNKNOWN`), `ROUND_LIMIT:<column>`, `VERDICT_FAIL:<column>`, `PLANNING_DIFF_INVALID`, `RUN_FAILED:<column>`, `OUTCOME_UNSUPPORTED:<column>`, or the code of an error raised while applying.
- **Applying** (`board.apply_outcomes`, after `workflow.advance` in the loop): a terminal run with `run_id ≠ applied_run_id` is applied once, in one transaction that sets `applied_run_id`, clears assignee and lease, and writes `ticket.outcome_applied`. A paused run blocks the ticket only while it is still in its working status and does **not** set `applied_run_id`, so the run is applied again when it ends (late-outcome rows when the ticket is still `blocked`). Git commits happen before that transaction; a crash in between is recovered by reusing HEAD when its subject is the expected message and no `ticket.committed` event records it.

### D. Locks

- **Worktree lock.** The existing P00 rule (`tasks._mutating_in_workspace`), keyed by the run's workspace path. A worktree is its own path, so developers on two tickets never collide. Develop and test on one ticket run one after the other because the ticket holds one column at a time.
- **Main-checkout lock.** It is the same rule on the main-checkout path. Unpack, triage and refine runs hold it for their run. The merge step checks it, then holds it for the merge with a coordinator-internal flag (`board_locks` row, `merge`, cleared in the same transaction that records the merge). So unpack, triage, refine and merge are serialized with each other. The scheduler never starts a main-checkout column while the lock is held or the main checkout is dirty; that column is **held** (`board.held {column, reason}` event, once per reason change), never failed.

### E. Git and worktrees (coordinator only)

- Agents never run history-changing git. Every git call is in `worktrees.py` / `gitws.py`, an argv list with no shell, run by the coordinator.
- Root: `<state>/worktrees/<sha256(workspace)[:12]>/<key>/`, where `<state>` is the coordinator state dir from `paths.py` (WSL-native, never under `/mnt/`).
- Create at the first `in_dev`: `git worktree add -b ticket/<key>-<slug> <path> <baseBranch>`, where `<slug>` is `[a-z0-9-]{1,40}` from the title. Record `branch`, `worktree_path`, `base_commit`. A branch is created only once all dependencies are `merged`, so it starts from them.
- After a succeeded develop run: `git add -A` + `git commit -m "<key>: develop round <n>"` in the worktree, then record `head_commit`. Nothing to commit → findings `NO_CHANGES`, counted like a failed dev round.
- Registered worktree = a `tickets` row with that `worktree_path` (compared after `realpath`), status not terminal, **and** listed in `git worktree list --porcelain` of the main checkout under the worktree root (`worktrees.list_registered`). Anything else → `WORKTREE_NOT_REGISTERED`, including paths that do not exist. `workflow.start` / `task.direct` take an optional `workspace`: omitted or equal to the team's workspace means the main checkout; anything else must be a registered worktree (`tickets.registered_worktree`, S04). The run's task row stores the chosen path, and every later step reads it from there.
- Recording a created worktree on its ticket is `tickets.record_worktree` (sets `branch`, `worktree_path`, `base_commit`; event `ticket.worktree_created`), used by S05 and by the debug-only test fixture `debug.ticket_worktree` (S04).
- Merge (S07), in the main checkout under the merge lock:
  - `git merge --squash <branch>`, then the `Status:` line rewrite, then `git commit --allow-empty -F <file>`, with the message ending in the trailer `Ticket: <key>`.
  - A conflict or an interrupted squash is undone with `git reset --merge`, never `git merge --abort`: a squash leaves no `MERGE_HEAD`.
  - At startup, a leftover lock row whose HEAD already carries the trailer is completed without a second commit.
  - The develop start after a conflict merges `baseBranch` into the worktree, committing the markers if it conflicts. It is recorded as `ticket.committed {baseMerge: true}`, which develop-round numbering does not count.
- Removal after `merged` or `cancelled`: `git worktree remove --force <path>`, after the ticket's run is terminal. Startup reconcile removes worktrees under the root that have no live ticket (`board.worktree_orphan_removed` event) and re-creates nothing.

### F. Planning commits

- After an unpack, triage or refine run, the coordinator lists the main checkout's changed paths (`git status --porcelain --untracked-files=all`). The tree was clean at run start (P01 rule).
- Allowed paths:
  - refine: the story file, the files in its phase folder (`phases/phase-NN/**`, for the README contract and dependent stories);
  - unpack: everything under `out_dir`;
  - triage: at most one new or changed path, which must fully match `bugs/BUG-<key>-[a-z0-9-]{1,40}\.md` (`<key>` is the ticket key verbatim, e.g. `bugs/BUG-T-004-login-crash.md`); its commit message names that path, and it becomes the ticket's `story_path` (S08).
- Unpack manifest `<out_dir>/tickets.json` (S09, `manifest.validate`): `{"stories": [{"path", "title", "dependsOn"?: [path], "priority"?: 1..5}], "questions"?: [str]}`, no other keys; 1–30 stories (0 allowed with non-empty `questions`); every `path` is **workspace-relative**, under `out_dir/`, an existing `.md` story file with the story-format sections; `dependsOn` names manifest paths only, acyclic. Failure → `MANIFEST_INVALID` with `{path, message}` errors. The feature's `{{task}}` carries `Brief:` and `Out:` lines.
- All paths allowed → `git add -- <paths>`, then `git commit -m "<key>: <column> <path>" -- <paths>` on `baseBranch` in the main checkout (HEAD must be `baseBranch`, else `MAIN_CHECKOUT_WRONG_BRANCH` and the ticket is `blocked`).
- Any path outside → `PLANNING_DIFF_INVALID`, ticket `blocked` with the offending paths, **nothing committed and nothing reverted** (the coordinator cannot tell agent edits from operator edits). Main-checkout columns then stay held until the operator cleans the tree (§D).

### G. Scheduler

Runs in the coordinator loop after `workflow.advance` (`board.tick(store, ctx)`). It is off until `board.run` and stops at `board.pause`. Each tick, for each agent with availability `idle` (not `busy`, `waiting_input` or `limit_reached`) of the running team on the board's workspace, it takes the first eligible ticket for the agent's role(s) from `board.json` columns. Order inside a priority: `priority`, then oldest `created_at`.

| Role (via columns) | Order |
|---|---|
| unpack | `ready_unpack`; one main-checkout run at a time |
| review / triage / refine (same role) | `ready_review` > `triage` (blocker first) > `refine`; if the last two picks of this agent were reviews and a refine/triage ticket waits, that one goes first (starvation guard) |
| develop | blocker bugs > `changes_requested` / `fail_test` > `ready_dev` bugs by severity > `ready_dev` stories; every dependency `merged`; `in_dev` count < `maxParallelDev` (a `blocker` bug may make it `maxParallelDev + 1`) |
| test | `ready_test` |

- Priority across roles is irrelevant (each agent has one role). Inside the lead's role, `ready_review` beats `ready_unpack` when the same agent is bound to both columns.
- **Claim** = one transaction: status `ready_x` → `in_x`, `assignee_agent_id`, `lease_until = now + leaseSeconds`, `ticket.claimed`. Then the coordinator prepares the worktree and starts the run, which sets `run_id`. While the run is active it owns the ticket; the lease only covers the gap between claim and run start.
- **Severity → priority:** blocker 10, major 40, minor 70 (`schema.BUG_SEVERITY_PRIORITY`; set by the triage outcome, overriding a create-time `priority`). Stories default to 100, or the manifest priority × 10 + 50 (manifest priority 1–5).

### H. Usage limits

- Adapters classify a provider result that means "usage/rate limit reached" as diagnostic `USAGE_LIMIT`, with `limitResetAt` when the provider reports one. The text and exit codes are verified on the real CLI (Claude first). Unrecognised failures stay `PROVIDER_ERROR`.
- Effect: the run is cancelled by the board (not paused), the ticket goes back to the column it was picked from (`ticket.released {reason: "usage_limit"}`), and no round is counted. The agent's availability becomes `limit_reached` (+ `limit_reset_at`), which needs schema **v8** (rebuild `agents` for the CHECK, the same rebuild pattern as P01 §F). A `board.limit_reached` event is written.
- Only `board.resume {workspace, agentId? | all: true}` clears it. There is no automatic retry. `board.pause {reason: "usage_limit"}` is the team-wide hold.

### I. Commands and errors

| Command | Args | Kind |
|---|---|---|
| `ticket.create` | `workspace`, `kind`, `storyPath` / `briefPath`+`outDir` / `text`+`attachments?`, `title?`, `dependsOn?` [keys], `noDeps?`, `priority?` | mutating |
| `ticket.show` / `ticket.list` | `workspace`, `key` / `status?`, `kind?` | read-only |
| `ticket.move` | `workspace`, `key`, `to`, `reason?` | mutating |
| `ticket.block` / `ticket.unblock` | `workspace`, `key`, `reason` / — | mutating |
| `ticket.cancel` | `workspace`, `key`, `reason?` (cancels an active run first) | mutating |
| `ticket.depend` | `workspace`, `key`, `on` [keys], `remove?` [keys] | mutating |
| `ticket.approve` | `workspace`, `key` (feature parent; releases held children) | mutating |
| `ticket.start` | `workspace`, `key`, `agentId` (manual claim + run, no scheduler) | mutating |
| `ticket.retry` | `workspace`, `key` (releases a lease with no active run) | mutating |
| `board.show` | `workspace` | read-only |
| `board.run` / `board.pause` / `board.resume` | `workspace`, `reason?` / `agentId?`, `all?` | mutating |

Mutating commands need an idempotency key (P00 rule) and go through the command inbox; `ticket.show`, `ticket.list` and `board.show` read the database directly, like `workflow.show`. The CLI and `serve` return identical JSON. `ticket.create` checks every path with `tickets.check_workspace_path` (relative, inside the workspace after `realpath`, an existing `.md` file; else `STORY_PATH_INVALID`); omitted `dependsOn` uses parsed story dependencies, while a supplied list (including `[]`) overrides them. Its receipt is `{ticket, dependsOn, parsed {ids, resolved, unresolved}, warnings [{code: "DEPENDS_UNRESOLVED", id}]}` (S02); S08 adds `kind: bug` (`text` required ≤ 32 KiB, `attachments?` ≤ 20 existing workspace paths of any type, `title?` ≤ 80 chars defaulting to the first line of the text, no `storyPath`, no parsed dependencies) and S10 `kind: feature`. New error codes: `TICKET_NOT_FOUND`, `TICKET_TRANSITION_INVALID`, `TICKET_BUSY`, `TICKET_DEPENDENCY_CYCLE`, `STORY_PATH_INVALID`, `BOARD_CONFIG_INVALID`, `WORKTREE_NOT_REGISTERED`, `WORKTREE_EXISTS` (S03 `create` on an existing branch or path), `MAIN_CHECKOUT_DIRTY`, `MAIN_CHECKOUT_WRONG_BRANCH`, `PLANNING_DIFF_INVALID`, `MANIFEST_INVALID`, `BUG_FILE_INVALID`, `MERGE_CONFLICT`, `USAGE_LIMIT`, `TICKET_ROLE_MISMATCH` (`ticket.start` agent role ≠ column role), `TICKET_DEPS_NOT_MERGED` (`{blockedBy}`, develop start with an unmerged dependency). `ticket.start` returns `{ticket, column, workflowRunId, definition, workspace}`; any start error rolls back the claim and removes a worktree created by that call (S05).

### J. Events

`ticket.created`, `ticket.moved {from, to, by, reason}`, `ticket.claimed {agentId}`, `ticket.run_started {runId, definition}`, `ticket.worktree_created {branch, path, baseCommit}`, `ticket.released {reason}` (`run_cancelled`, `usage_limit`, …), `ticket.findings {column, count}`, `ticket.committed {branch|baseBranch, commit, paths?, runId, baseMerge?}`, `ticket.outcome_applied {runId, column, runStatus, verdict, to, reason}`, `ticket.merged {commit}`, `ticket.merge_conflict {files}`, `ticket.merge_message_defaulted`, `ticket.depends {on}`, `ticket.children_created {keys}`, `board.started`, `board.paused {reason}`, `board.held {column, reason}` (for `merge`, a ticket event of the waiting ticket; reasons `MAIN_CHECKOUT_BUSY|DIRTY|WRONG_BRANCH`), `board.limit_reached {agentId, resetAt}`, `board.resumed`, `board.worktree_orphan_removed {path}`.

## Requirements (this phase)

| ID | Requirement | Proof |
|---|---|---|
| R-17 | Durable tickets with a closed transition table | Unit tests on every allowed and refused transition; restart keeps every ticket. |
| R-18 | Parallel developers without workspace contamination | Two `in_dev` tickets on two worktrees at once; the main checkout is unchanged until the merge. |
| R-19 | Coordinator-only git | Agents' prompts and permissions never include git history changes; every commit and merge is a `ticket.committed` / `ticket.merged` event. |
| R-20 | Dependencies respected | A dependent is never claimed by a developer before its blockers are `merged`, and its branch starts from the merged base. |
| R-21 | Bounded loops and honest stops | Round limits → `blocked`; usage limits stop only the affected agent and burn no round. |
| R-22 | Unattended flow, manual brakes | `board.run` moves 3 tickets to `merged` with real providers; `board.pause`, `ticket.move` and `ticket.cancel` work at every column. |

## Non-goals for P03

UI (P02 renders `board.show`), stacked branches, branch deletion, `needs_split`, bug approval gate, automatic retry after usage limits, desktop notifications, agents running git history commands, more than one team per workspace, cross-workspace boards, estimates and reporting, and changes to the P01 engine beyond the `workspace` and `seed` arguments.

## Phase exit

P03 is Done when S01–S16 are Done with evidence and [P03-S17](./stories/P03-S17-live-gate.md) records a real board run on a throwaway repository with real providers: three story tickets, one dependency and one forced QA fail, all `merged`. Fake-provider tests prove the transitions, scheduling and recovery; they never prove a real provider.
