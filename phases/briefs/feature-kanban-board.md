# Feature brief: asynchronous ticket board (kanban) for the agent team

Status: decisions recorded 2026-10-22 (section 9); ready for `team unpack`. Written to be fed to `team unpack` (phases -> epics -> stories). Builds on P01 (definitions, routing,
recovery, `workflow.*` commands) and on the P00 rules about one-shot tasks and the workspace write lock.

## 1. Goal

Today the operator drives one story at a time: `team run story-delivery --story S` and waits. The goal is a **board**
where tickets move through columns and idle agents **pull** work by role, in parallel, without the operator in the loop:

```
 backlog -> ready_unpack -> unpacking -> (child tickets) refine -> ready_dev -> in_dev -> ready_test -> in_test -> ready_review -> in_review -> merged
                                      ^            |            |
                                      +-- fail_test (QA)         +-- changes_requested (lead)
 bug:  (operator text) -> triage -> ready_dev -> in_dev -> ... same as stories ... -> merged
 any column -> blocked (waiting on another ticket or on the operator)
```

- **ProductOwner (PO)** picks `ready_unpack` tickets (a feature/epic brief: the operator's idea or a larger item),
  unpacks them into story files, and the coordinator turns each story into a child ticket in `refine`.
  The parent becomes `unpacked` and is `done` when all its children are `merged`.
- **Bugs:** the operator describes a bug in plain words; it enters as a `bug` ticket in `triage`. The TeamLead picks it
  up, investigates, writes the bug file (steps to reproduce, expected vs actual, suspected area, done criteria,
  severity) and the ticket goes straight to `ready_dev` (no refine). See 3c.
- TeamLead picks `refine` tickets, fixes the story, moves it to `ready_dev` (or `blocked` with questions).
- Developer picks `ready_dev` and `fail_test`/`changes_requested` tickets whose dependencies are merged, implements on
  the ticket's **own branch + worktree**, then moves it to `ready_test`.
- QA picks `ready_test`, tests that same branch/worktree, then `ready_review` (pass) or `fail_test` (fail, findings kept).
- TeamLead picks `ready_review`, reviews the branch, then **merges** it to the base branch (`merged`) or sends it back
  with findings (`changes_requested`).
- A ticket whose `blockedBy` tickets are not `merged` is never picked up by a developer.

## 2. Why this is feasible with the current design

- The write lock is per **workspace path** (`tasks._mutating_in_workspace`: `task.workspace` + active
  `workspace_write` assignment, or a running workflow on that path). A git worktree is a different path, so two
  developers on two worktrees do not collide. The lock stays; we only stop sharing one path.
- Everything a stage needs is already frozen per run: definition, bindings, prompts, diff capture
  (`gitws.capture_diff(workspace, base, ...)`), validation, recovery after restart. A ticket's pipeline can **be** a
  workflow run (the `story-delivery` stages), started in the ticket's worktree.
- Agents are one-shot and remember nothing. That fits a board: the ticket (files + state) is the memory.

What does **not** exist and must be built: durable ticket state, a scheduler that matches idle agents to tickets,
worktree lifecycle, dependency/blocked logic, merge handling, and a board view. Detail below.

## 3. Key design decisions (recommended defaults; open ones in section 9)

1. **Tickets live in the coordinator's SQLite** (new `tickets` table + `ticket_events`), not in markdown. Story files
   stay the spec; the board is the state. A ticket points at a story path and a branch. Reason: atomic claims,
   crash-safe transitions, one source of truth the UI (P02) can read.
2. **A ticket is a long-lived record; each column visit is a workflow run.** The scheduler starts a *single-stage or
   few-stage* definition per column (`refine`, `develop`, `test`, `review`) rather than one long workflow. This keeps
   the P01 engine unchanged, gives per-stage recovery for free, and lets different agents hold different columns at
   different times. (Alternative: one big workflow per ticket. Rejected: it holds a single bound agent per role for the
   whole ticket and cannot wait for a free QA.)
3. **Pull model with leases.** An idle agent is offered the highest-priority eligible ticket for its role; the claim is
   a single transaction (`ticket.status` + `claimed_by_agent` + `lease_until`). Crash or timeout releases the lease
   (reuses reconcile rules); the ticket returns to its `ready_*` column.
4. **One branch per ticket** `ticket/<id>-<slug>`, created from the base branch (or from the merge-base of its
   dependencies once merged). Developer and QA use the **same worktree** one after the other (never concurrently);
   lead reviews that worktree read-only and merges with git from the coordinator side (agents never merge).
5. **The coordinator performs git operations, agents do not.** Create/remove worktree, commit the developer's changes
   on the branch, compute diffs, run `git merge`. Agents only read/write files in their worktree and (after S-cmd work,
   already done) run an allowlisted set of commands. This keeps history-changing git out of agent hands.
6. **Roles: ProductOwner (new), TeamLead, Developer, QA**; several agents can share a role (2 developers). Binding is by
   agent availability at pickup time instead of fixed at run start.

## 3b. Unpacking: the ProductOwner and `ready_unpack` (operator request, 2026-10-22)

- **New role `ProductOwner`** in `team.json` / `roles.json` (`.agent-studio/roles/product-owner.md`, skill `story-format`
  reused). Today `team unpack` asks the TeamLead to do this; the PO takes that work so the lead is free for refine and
  review. `team unpack` stays as the manual shortcut and uses the PO when one exists.
- **Ticket kinds:** `feature` (a brief/epic, enters at `ready_unpack`) and `story` (enters at `refine`). A story ticket
  has `parent_ticket_id`. `ticket add --brief PATH` creates a feature ticket; `ticket add --story PATH` a story ticket.
- **Unpack stage** (a workflow definition `unpack`, one `workspace_write` stage for the PO, plus a verdict): the PO reads
  PRD/ROADMAP/phases and the brief and writes planning files **only** (a phase README and one story file per story, in
  the output folder named on the ticket, e.g. `phases/phase-02/`), following the story-format skill, **and** a machine-
  readable manifest `<out>/tickets.json`:
  `{"stories": [{"path": "...", "title": "...", "dependsOn": ["<path>", ...], "priority": 2}], "questions": []}`.
- **After the stage (coordinator, not the agent):**
  1. validate the manifest (paths exist and live under the output folder, each story file has the required sections,
     dependency graph is acyclic, no unknown paths, limits on count) and the diff touches planning files only;
  2. commit those files to the base branch (same rule as refine: planning commits go to base so branches start from them);
  3. create one child ticket per story in `refine`, with the manifest's dependencies (plus any `Depends on:` lines parsed
     from the files, shown to the operator; override later with `ticket.depend`);
  4. parent -> `unpacked`; if `questions` is non-empty the parent goes to `blocked` with them instead and creates nothing,
     so the operator can answer in the brief and run `ticket.move <id> ready_unpack` to unpack again (same loop as
     `team unpack` today). Re-unpacking an already unpacked parent updates existing children (matched by story path) and
     never deletes a child that has left `refine`.
- **Scheduler:** `ready_unpack` is offered to ProductOwner agents only; one unpack runs at a time per repo (it writes to
  the main checkout, like refine; refine and unpack share that serialization lock). Priority: `ready_review` (lead) >
  `ready_unpack` (PO) so the pipeline keeps filling while the lead reviews.
- **Review of the plan:** an optional operator gate `board.require_plan_approval` holds new child tickets in `backlog`
  until the operator runs `ticket.approve <parent>`; default off (children go straight to `refine`).
- **Usage limits** (6b) apply to the PO like any agent.
- **Tests:** fake provider writes a manifest and story files; unit tests for manifest validation (cycles, escaping
  paths, duplicates); integration: feature ticket -> 3 child tickets with one dependency; questions path; re-unpack is
  idempotent; PO cannot touch files outside planning docs (diff check).

## 3c. Bugs (operator request, 2026-10-22)

- **Intake:** `team.py bug "description"` (or `--file PATH`, repeatable `--attach PATH` for logs/screenshots paths) calls
  `ticket.create --kind bug`. The raw text is stored on the ticket (`raw_text`) and the ticket is `triage`. The operator
  never has to write the structure; they describe the problem the way they would to a colleague.
- **Triage stage** (definition `triage`, TeamLead, `workspace_write` limited to the bug file, plus a verdict): the lead
  reads the description, searches the code (code-search skill), tries to reproduce by reading code and, where a test
  can show it, running existing tests/commands, then writes `bugs/BUG-<key>-<slug>.md` from a bug template:
  title, severity (`blocker|major|minor`), **steps to reproduce**, **expected vs actual**, environment/version, suspected
  files/functions, **done criteria** (observable fix + a regression test that fails before and passes after), out of
  scope, and open questions. Verdict `pass` = ticket is specified; `fail` = the lead cannot proceed (not reproducible,
  missing info): questions go on the ticket, status `blocked`, operator answers and moves it back to `triage`.
- **After the stage (coordinator):** validate the bug file has every required section, commit it to the base branch
  (planning-files rule), set `story_path` to it, severity -> priority, and move the ticket to **`ready_dev`**.
  Duplicates: the lead may mark `duplicate_of: <key>` and the ticket closes as `cancelled` with a link.
- **Pipeline from there is the story pipeline:** developer works on `ticket/<key>-<slug>`, **first writes a failing
  regression test**, then fixes; QA re-runs the repro steps and the regression test and checks nothing else regressed;
  lead reviews and squash-merges (message references the bug key). Bug-specific prompts for develop/test/review.
- **Scheduler priority:** for Developer, `blocker` bugs > `fail_test`/`changes_requested` > other bugs by severity >
  stories; for TeamLead, `ready_review` > `triage` (blockers first) > `refine`. `maxParallelDev` still applies, but one
  slot is reserved for a `blocker` bug (it may exceed the cap by one).
- **Tests:** fake lead writes a valid and an invalid bug file; unit tests for the bug-file validator and priority mapping;
  integration: raw bug -> `ready_dev` with correct fields, not-reproducible -> `blocked`, duplicate -> `cancelled`, a
  blocker bug jumps the developer queue.

## 4. Data model

`tickets`: id, team_id, key (`T-001`), kind (`feature`|`story`|`bug`), raw_text (bug intake), severity, duplicate_of, parent_ticket_id, title, story_path (story) or
brief_path + out_dir (feature), status, priority, branch, worktree_path, base_commit,
head_commit, assignee_agent_id (nullable), lease_until, attempt counters per column (`dev_rounds`, `test_rounds`,
`review_rounds`), `blocked_reason`, created/updated, `merged_commit`.
`ticket_deps`: ticket_id, blocked_by_ticket_id. `ticket_events`: append-only journal (moved, claimed, released,
findings, merge) feeding the same event stream (`events.after`) the UI already polls.
Allowed transitions are a table in code (like P00 state machines): anything else is rejected. `blocked` stores the
column to return to. Findings from QA/lead are stored on the ticket and passed into the next developer prompt.
Schema migration v7 (same migrate helper, foreign_key_check).

## 5. Commands (CLI + `serve`, identical JSON)

`ticket.create / show / list / move / block / unblock / cancel`, `ticket.depend --on`, `board.show` (columns with
tickets, who holds what), `board.run` / `board.pause` (scheduler on/off), `ticket.retry` (release a stuck lease).
`team.py board`, `team.py ticket add STORY [--depends T-001]`, `team.py board run`. Operator can always drag a ticket
by hand (`ticket.move`), which is also the escape hatch for any bug.

## 6. Scheduler (the new moving part)

Runs inside the coordinator tick (same loop that already does reconcile/deadlines). Each tick, for every idle agent
(availability `idle`, no `waiting_input`), by role:

| Role | Eligible tickets (priority order) |
|---|---|
| ProductOwner | `ready_unpack` (oldest first), one unpack at a time |
| TeamLead | `ready_review` first (unblock the pipeline), then `triage` (blocker bugs first), then `refine` |
| Developer | blocker bugs, then `changes_requested`, `fail_test`, then `ready_dev` (bugs by severity, then stories), only if every dependency is `merged` and the number of tickets `in_dev` < `maxParallelDev` |
| QA | `ready_test` |

Claim -> prepare worktree (coordinator) -> start the column workflow in that worktree -> on completion apply the
outcome: pass/fail verdict decides the next column; failure counters over the limit move the ticket to `blocked` for
the operator (no infinite fail/fix loops; limits configurable, default 3 per column). Fairness: oldest first within a
priority. Starvation guard: lead alternates review and refine.

## 7. Git and worktrees

- Worktree root outside the checkout: `~/.local/state/agent-studio/worktrees/<team>/<ticket>/`
  (`git worktree add -b ticket/<key>-<slug> <path> <base>`). Needs `.agent-studio` committed in the base (it is).
- `workspace` becomes a per-task/run argument: `workflow.start --workspace <worktree>` and `task.direct` accept a
  worktree **registered for the team** (validated against `git worktree list` and a `ticket` row; arbitrary paths
  refused). Role context and `workflow.json` are read from the worktree.
- After the developer stage the coordinator commits on the branch ("T-001: develop round N") so the diff base is
  stable and the lead reviews real commits. QA runs read-only against the same worktree.
- Lead review prompt gets the diff base..branch (read-only stage); **merge is a coordinator action** triggered by a
  `pass` verdict: `git merge --squash` + `git commit -F <lead's commit block>` into the base branch in the *main* checkout, serialized by a
  merge lock. Conflict -> ticket goes to `changes_requested` with the conflict text; a developer rebases/merges the
  base into the branch (allowed in the worktree via an explicit coordinator-run `git merge <base>` step).
- Dependencies: a dependent ticket's branch is created after its blockers are merged (so it starts from the merged
  base). Optional later: stacked branches.
- Cleanup: `git worktree remove` after merge or cancel; orphan worktrees reconciled at coordinator start.
- Danger zones handled explicitly: dirty main checkout (merge refused with a clear error), operator editing the main
  checkout while the board runs (documented; merge needs a clean tree), worktree path on `/mnt/c` is slow (use the
  WSL filesystem for worktrees and the runtime copy).

## 8. Delivery plan (stories, in order; each independently testable on the fake provider)

**Epic A - Foundations**
- A1 Ticket model: schema v7, state table, `ticket.*` commands, events, `team.py ticket`. No agents involved.
- A2 Worktree service: create/remove/list/reconcile worktrees and branches, commit-on-branch, safe path validation.
- A3 Per-run workspace: `workflow.start`/`task.direct` take a team-registered worktree; lock keyed by that path; role
  context from the worktree; tests for two parallel writers on two worktrees and for refusal of foreign paths.

**Epic B - Column pipelines**
- B00 Bug tickets: `bug` kind, `triage` column, `triage` definition and bug-file template/validator, `team.py bug`,
  bug-specific develop/test/review prompts, severity priority, blocker slot (section 3c).
- B0 Unpack stage: `ProductOwner` role + files, `unpack` definition, manifest schema/validation, coordinator step that
  commits planning files and creates child tickets, parent `unpacked`/`done` rules, `team.py ticket add --brief`.
- B1 Column definitions (`refine`, `develop`, `test`, `review`) as built-in/project definitions and a mapping
  column -> definition + outcome -> next column. Verdict stages already exist.
- B2 Outcome applier: run completion -> ticket transition + findings storage + counters + limits -> `blocked`.
- B3 Merge step: coordinator-side `git merge`, merge lock, conflict path, post-merge unblock of dependents.

**Epic C - Scheduler**
- C0 Usage-limit classification and agent `limit_reached` state (section 6b), `board.resume`.
- C1 Claim/lease transaction and release on crash/timeout/restart (extend reconcile).
- C2 Role-based picker with dependency check, `maxParallelDev`, priorities, pause/resume (`board.run/pause`).
- C3 Multi-agent rosters: team.json with 2 developers; binding by availability; per-agent concurrency of one.

**Epic D - Operator experience**
- D1 `board.show` + `team.py board` (text kanban), `ticket.move` escape hatch, `team.py ticket add --depends`.
- D2 Recovery doc + failure drills (kill coordinator mid-ticket, kill runner, merge conflict, blocked ticket).
- D3 Live gate on a throwaway repo with real providers (3 tickets, one dependency, one forced QA fail), operator-run
  like P01-S10. P02 UI later renders `board.show`; no UI work in this feature.

Estimated order of value: A1+A2+A3 (worktrees alone already let two stories run in parallel by hand) -> B -> C -> D.

## 9. Decisions (operator answers, 2026-10-22)

00. **Bugs:** a `bug` ticket type; the operator describes it, the TeamLead triages it into a structured bug file
   (repro steps, expected/actual, done criteria incl. a regression test) and the ticket goes to `ready_dev`
   (section 3c). Open sub-question: should the operator be asked to confirm the lead's bug file before dev starts
   (a `board.require_bug_approval` gate like the plan gate)? Recommended: off by default, since the lead already
   validated it and the operator can edit the file or move the ticket back to `triage`.
0. **Unpack:** a `ready_unpack` status picked up by a ProductOwner agent that unpacks into stories which enter
   `refine` (section 3b). Open sub-questions: should the PO also be able to split an existing story that refine finds
   too big (a `needs_split` loop back to `ready_unpack`)? Recommended: yes, later, as a follow-up story.

1. **Merge:** squash and merge. The lead writes the squash commit message (the `commit` block of its review verdict);
   the coordinator runs `git merge --squash <branch>` then `git commit -F` in the main checkout, under the merge lock.
2. **Parallelism:** `maxParallelDev` default 2 is accepted (configurable).
3. **Lead during review:** read-only. The review stage uses `read_only`; the lead can only approve (with the commit
   message) or request changes (findings). Merge conflicts and fixes go back to a developer.
4. **Refine commits to base:** the lead edits the story in the main checkout during `refine`; the coordinator commits
   exactly the planning files it changed to the base branch before the ticket becomes `ready_dev`, so branches and
   dependents start from the refined story. Refine is serialized (one at a time) because it writes to the main checkout.
5. **Usage limits:** see section 6b. Visible to the operator, scheduler holds, operator resumes manually.
6. **Dependencies:** parsed from the story's `Depends on:` line on `ticket add`, shown back to the operator, and
   overridable with `--depends` / `--no-deps` or `ticket.depend` later.

## 6b. Usage-limit handling (decision 5)

- **Detection:** each adapter classifies a provider result that means "usage/rate limit reached" (message text and exit
  codes verified per provider against the real CLI; Claude first) as diagnostic code `USAGE_LIMIT`, with the reset time
  when the provider reports one. Unrecognised failures stay `PROVIDER_ERROR` (no guessing).
- **Effect on the assignment:** it ends `failed`/`USAGE_LIMIT` without counting as a ticket fail round (no QA/dev
  "attempt" is burned), and the ticket returns to its `ready_*` column with its lease released and a `ticket_event`.
- **Effect on the agent and team:** the agent gets `availability: limit_reached` (+ `limitResetAt`). The scheduler never
  offers work to that agent. If every agent of a needed role is limited, that column simply stops; other columns keep
  going. A team-wide hold (`board.pause --reason usage_limit`) applies when the operator or a threshold (default: any
  agent) says so; default is per-agent so unaffected roles keep working.
- **Visibility:** shown in `board.show`, `snapshot`, the agent pane header, `team.py status`/`board` (a red
  `LIMIT: dev (claude) until 14:05` line), and a `board.limit_reached` event for the UI; optional desktop/push
  notification hook later.
- **Manual resume:** `board.resume [--agent ID | --all]` (and `team.py board resume`) clears the flag and re-enables
  pickup; no automatic retry loop spends tokens against a limit. If the limit is still active the next assignment
  fails with `USAGE_LIMIT` again and the flag returns (one wasted call, not a loop). Optional: surface the provider's
  reset time so the operator knows when to resume.
- **Tests:** fake provider scenario `usage_limit`; unit tests for each adapter's classifier; integration: limit mid-ticket
  keeps the ticket in its column, blocks only that agent, `board.show` reports it, `board.resume` continues.

## 10. Risks

- **Merge conflicts between parallel tickets** are the main new failure mode; mitigated by dependencies, small
  stories, and the conflict -> developer loop with a round limit.
- **Agent commands without restriction** (already enabled for Claude): a developer's shell runs inside its worktree
  but can still reach the machine. Keep the "no history-changing git" prompt rule and consider an allowlist later.
- **Scheduler bugs create busy loops or lost tickets**: every transition is journaled, `ticket.move` and `board.pause`
  are the manual brakes, and the scheduler is off until `board.run`.
- **Cost**: parallel agents multiply token use; add per-ticket round limits and a visible counter in `board.show`.
