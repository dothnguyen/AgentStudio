# Running this project with an Agent Studio team

Team: **lead** = TeamLead, **dev** = Developer, **qa** = QA, and **po** = ProductOwner. Roles:
`roles.json`, `roles/*.md`; shared skills: `skills/`.
The workflow's automatic test step: `workflow.json` (unit tests).

Everything below runs **inside WSL** (Ubuntu-24.04). The `agent-studio team …` story commands only glue the normal
`agent-studio` commands together and run git and the tests in your shell.

## What P00 can and cannot do (so the steps make sense)

- Command access is opt-in per workspace: `.agent-studio/permissions.json`
  (`{"version":1,"claude":{"commands":true},"agy":{"commands":true},"opencode":{"commands":true}}`, present in this
  project). With it, Claude Developers can run any command in the workspace (tests, git), and QA and the lead get
  read-only commands (git status/diff/log/show/ls-files/rev-parse, ls, cat, the unit tests). Without it agents never
  run commands, and the built-in workflow's test step and the team commands run the tests for them. **You** commit
  (with the lead's message); the story-delivery prompts forbid history-changing git.
- OpenCode, Claude and agy each read their own key in that file (`opencode`, `claude`, `agy`); enabling it for one does
  not change another.
- Turning on Claude's command access drops its `--restricted` flag, so file tools are no longer confined to the
  workspace and project settings files are honoured. Only enable it for workspaces you trust. OpenCode's file tools
  stay confined to the workspace and its project config is disabled for every run.
- Each task is one-shot: an agent remembers nothing between tasks. Files (stories, plans) are the memory.
- The built-in workflow is fixed: dev -> unit tests -> QA -> at most one repair round. Further dev/QA rounds and the
  lead's reviews are direct tasks that the team commands send for you.
- Only one agent writes to the workspace at a time; a second writer is refused (`WORKSPACE_BUSY`).

## One-time setup

1. Run Agent Studio from a **separate copy**, so the dev agent never edits the code that is running the team:

   ```bash
   git -C /mnt/c/Works/Projects/AgentStudio add -A
   git -C /mnt/c/Works/Projects/AgentStudio commit -m "P00 complete; team configuration"
   git clone /mnt/c/Works/Projects/AgentStudio ~/agent-studio-runtime
   bash ~/agent-studio-runtime/backend/install.sh
   agent-studio coordinator stop; agent-studio coordinator start
   ```

   To pick up committed backend changes later: `git -C ~/agent-studio-runtime pull`, then restart the coordinator
   (only when no work is running).

2. Make sure `~/.local/bin` is on your PATH (`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc`), and that
   `claude auth status` shows you logged in.

3. Teams come only from `.agent-studio/teams/<id>.json`. A leftover legacy `.agent-studio/team.json` is ignored;
   if there is no saved team, create one with `agent-studio team add --name NAME`.

## Daily: start and watch

```bash
cd /mnt/c/Works/Projects/AgentStudio
agent-studio team start    # the panes: lead, dev, qa (the team definition from .agent-studio/teams/)
agent-studio team attach   # in a second terminal; Ctrl-b d detaches, Ctrl-b z zooms a pane
agent-studio team status   # who is busy, recent results
```

From Windows Terminal, `agent-studio team attach --team <id> --print` gives a ready `wt.exe ...` command.

## Workflow 1 - unpack a feature with the product owner

1. Write a brief, e.g. `phases/briefs/feature-x.md`: the goal, users, constraints, what is out of scope.
2. `agent-studio team unpack phases/briefs/feature-x.md --out phases/phase-02`
   The product owner reads PRD/ROADMAP/phases, writes `phases/phase-02/README.md`, one story file per story, and
   `phases/phase-02/tickets.json`, then ends with open questions and decisions for you. The lead remains the fallback
   if the team has no ProductOwner.
3. Read the files. Answer the questions **in the brief** (add an "Answers" section) or edit the plan directly, then
   run the same `team unpack` again; the product owner revises the files. Repeat until you are happy.
4. Commit the plan: `git add -A && git commit -m "Plan: feature X"`.

One-off requests to the ProductOwner also run in an isolated worktree because of the role's `directTask` policy.
Use `agent-studio team ask --member po --wait "..."` for board-only work such as creating tickets, or add
`--policy workspace_write` when the request edits planning files. On success the coordinator commits and merges the
task branch into `main`. A Git conflict creates a priority-zero `merge-conflict` ticket in the current phase; the
TeamLead picks it up in the preserved worktree, resolves the conflict, and the coordinator retries the merge.

## Workflow 2 - develop one story (configurable workflow, P01)

```bash
S=phases/phase-02/stories/P02-S01-something.md
agent-studio team workflows                # definitions available (built-in and .agent-studio/workflows)
agent-studio team check story-delivery     # validate it against the running team, no tokens spent
agent-studio team run-workflow story-delivery --story $S   # 1. lead reviews/fixes the story -> dev -> unit tests (run by the coordinator, outside any agent sandbox) -> QA -> lead final review
                                    #    a review "fail" stops with the lead's questions; QA/final "fail" goes back to dev
agent-studio team commit $S      # 2. runs the integration tests the change touched (parallel), shows the files and the
                                    #    lead's ```commit message, asks, then commits
```

The first stage is the lead's story review, so `team review` is not needed first.

`agent-studio team run-workflow NAME "prompt"` runs any definition with a free-text prompt (or `--text-file PATH|-`);
`--bind ROLE=MEMBER` picks a different member for a role, `--wait` follows the run to the end (without it the command
returns after starting). It needs a clean working tree and, with `--wait`, prints the route, status, last findings and
the last stage's summary. With `--story` it also records what `team commit` needs. The final stage may edit only the
story file: it marks the story Done, ticks items, fills Evidence and proposes the commit message; check the story
diff, then `team commit`.
The definition is `.agent-studio/workflows/story-delivery.yaml` with prompts in `workflows/prompts/`.

## Workflow 2b - develop one story by hand (P00 fallback)

```bash
S=phases/phase-02/stories/P02-S01-something.md
agent-studio team review $S   # 1. lead reviews the story and fixes it in place (offers to commit its edits)
                              #    -> APPROVED, or questions only you can answer
agent-studio team dev $S      # 2. dev implements -> unit tests -> QA -> (one repair round)
                              #    succeeded -> go to 4;  failed -> 3
agent-studio team fix $S      # 3. dev fixes QA's findings (and the failing tests)
agent-studio team qa $S       #    you run the tests here, QA reviews the diff + results
                              #    repeat fix / qa until "QA passed"
agent-studio team final $S    # 4. lead final review; if complete it marks the story Done (ticks, Evidence)
                              #    and proposes the commit message
                              #    changes requested -> team fix / team qa again, then team final
agent-studio team commit $S   # 5. shows the files and message, asks, then commits
```

Rules the commands enforce: `dev` needs the lead's approval (or `--force`) and a clean working tree (commit or stash
first); `final` needs QA passed; `commit` needs the lead's final approval. Per-story state (base commit, findings,
verdicts, commit message) lives in `~/.local/state/agent-studio/project-team/` (same files earlier releases wrote).

The story's Status/Evidence update made by the lead in `final` is included in the `team commit`.

## Test tiers

- **In the loop:** the workflow's `tests` stage runs `scripts/validate.py --touched`: the unit suite, then only the
  integration modules this change added or modified (including earlier committed rounds on a ticket branch), in
  parallel (`VALIDATE_WORKERS`, default 4). It runs outside the agent sandbox, so agents get integration results in
  VALIDATION even though they cannot run tmux themselves.
- **Manual loop (`team fix`, `team qa`, `team final`):** run only the unit tier before handing over, so they stay fast.
  Add `--integration` to also run the touched integration modules first.
- **At commit:** `team commit` runs the same `--touched` check as a final gate; `--skip-integration` commits anyway.
- **Occasionally:** `python3 scripts/validate.py --all` runs every integration module (end of an epic, before a release).
- **Fast loop only:** point `validation.argv` in `.agent-studio/workflow.json` at `--unit` to skip integration in the loop.

## Retry a stuck stage

```bash
agent-studio team retry     # rerun the active workflow's current stage with its original prompt
```
Use it when a stage is `waiting_input` (permission denied), the engine paused the run (verdict missing, unclear
restart), or an agent was lost. Same as `agent-studio workflow retry --workflow ID`. It refuses while the stage's
processes may still be running (cancel first) and when the agent is not alive. To give up instead:
`agent-studio workflow cancel --workflow ID`.

## When something goes wrong

| You see | Do |
|---|---|
| `WORKSPACE_DIRTY` on `team dev` | commit or `git stash` your changes first |
| `AGENT_BUSY` / `WORKSPACE_BUSY` | wait (`team status`) - one task per agent, one writer at a time |
| a task `waiting_input` (permission denied) | `agent-studio assignment resolve --assignment ID --action retry|fail|cancel` (see backend/RECOVERY.md) |
| a task `reconciling` after a restart | the same `assignment resolve` command |
| `failed` with `TIMEOUT` | the default limit is 30 min; split the story |
| an agent lost / pane closed | `team stop`, `team start` (state and story progress are kept) |
| anything else | `agent-studio task show --task ID --pretty` and the pane's output |

## Doing it by hand (what the team commands run)

```bash
agent-studio snapshot --team $TEAM --pretty                       # IDs and status
agent-studio task direct --team $TEAM --agent $LEAD --policy read_only \
    --text "REVIEW A STORY BEFORE WORK. Story file: $S" --wait --pretty
agent-studio workflow start --team $TEAM --developer $DEV --reviewer $QA \
    --text "Implement the story in $S ..." --wait --pretty
agent-studio workflow show --workflow $WF --pretty                # stages, diff path, test output, QA verdict
```

## Board columns and workflows

Tickets have a fixed column (`status`: `backlog`, `todo`, `in-progress`, `done`, or `closed`) and a separate
`workflowStatus` for routing. New operator tickets start in backlog with the initial workflow status `none`.
This workspace uses a version 4 `.agent-studio/board.json`: `workflowStatuses` (with exactly one `initial`, at
least one `done`, and at most one `closed` kind), `todoEntry`/`todoDefault`, and **no `rules`**. Routing lives in
`.agent-studio/workflows/*.yaml`; `agent-studio board workflow list` and the `board.workflows` command show each
workflow and report problems.

A board workflow starts when a ticket reaches its `startsAt` status and claims it into `whileRunning`. It declares
an optional `role` (no role means the coordinator runs it), `workspace` (`main` or `worktree`), `syncBase`,
`waitForDependencies`, `createdTickets`, `end` (`pass`, `fail`, optional `blocked`) and `limits`. Its `steps` run
in order:
- `agent` — a prompt file under `workflows/prompts/`, `access: read|write`, and optional `delegates`; the
  workflow's role is the agent.
- `check` — runs a check set from `.agent-studio/commands.json` against the files the branch changed. The
  `code` set runs `test-ui` for `app/` changes, `test-backend` for `backend/`/`tests/` changes, and `test-unit`
  otherwise, reusing a run that already passed on the same code.
- `action: merge` — the coordinator squash-merges the ticket branch itself.
- `approval` — waits for an operator decision.

`onPass` defaults to the next step (or `end-pass` on the last one) and `onFail` defaults to `end-fail`. A check
can send work back, e.g. `onFail: {retry: implement, max: 3, then: end-fail}`; `passRequires: [tests]` on a
verdict step makes its pass count only when that check passed. The develop and escalation workflows implement
`implement` → `tests` (`checks: code`) with that retry. QA runs `qa_tests` → `tests` → `qa` (`passRequires:
[tests]`).

The board applies exactly one result per run: `pass` moves to `end.pass`; `fail` moves to `end.fail` and counts a
round and the consecutive failures; `blocked` moves to `end.blocked.status` (default `blocked`) and remembers
`end.blocked.returnTo`; `paused` and `cancelled` release the claim without counting. `limits.maxRuns` blocks
with `ROUND_LIMIT:<workflow>`, `limits.failuresInARow` routes to its status with `FAILURE_LIMIT:<workflow>`,
and `limits.onFailPriority` sets the priority after a failure. A workflow's `createdTickets` holds tickets the
agent adds while it runs; `end.pass.releaseCreatedTickets: {from, to}` releases the ticket's children only when
the workflow passes.

Use `agent-studio ticket workflow KEY ID [--reason TEXT]` to change the workflow status of an unclaimed todo or
in-progress ticket without moving its column. `agent-studio board upgrade --dry-run` previews an upgrade and
`agent-studio board upgrade` persists it; the command backs up the board and any workflow files it replaces.
Version 2 boards upgrade in memory, version 3 boards convert their rules to workflow files and become version 4,
and a version 4 board is already upgraded. Upgrade the installed Agent Studio together with this workspace
config before running the board.
