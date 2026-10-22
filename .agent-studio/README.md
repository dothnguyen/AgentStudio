# Running this project with an Agent Studio team

Team (from `team.json`): **lead** = TeamLead on Claude Opus 5.5 (reasoning high), **dev** = Developer on Claude
Sonnet 5.5 (medium), **qa** = QA on Claude Haiku 5.5. Roles: `roles.json`, `roles/*.md`; shared skills: `skills/`.
The workflow's automatic test step: `workflow.json` (unit tests).

Everything below runs **inside WSL** (Ubuntu-24.04). `team.py` is `scripts/team/team.py`; it only glues the normal
`agent-studio` commands together and runs git and the tests in your shell.

## What P00 can and cannot do (so the steps make sense)

- Agents never run commands (no git, no tests). The workflow runs the unit tests itself; `team.py` runs them for
  the later QA rounds and passes the output to QA. **You** commit (with the lead's message).
- Each task is one-shot: an agent remembers nothing between tasks. Files (stories, plans) are the memory.
- The built-in workflow is fixed: dev -> unit tests -> QA -> at most one repair round. Further dev/QA rounds and the
  lead's reviews are direct tasks that `team.py` sends for you.
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

3. Optional shortcut: `alias team='python3 /mnt/c/Works/Projects/AgentStudio/scripts/team/team.py'`
   (the commands below use `team`).

## Daily: start and watch

```bash
cd /mnt/c/Works/Projects/AgentStudio
team start          # three panes: lead, dev, qa
team attach         # in a second terminal; Ctrl-b d detaches, Ctrl-b z zooms a pane
team status         # who is busy, recent results
```

From Windows Terminal, `agent-studio team attach --team <id> --print` gives a ready `wt.exe ...` command.

## Workflow 1 - unpack a feature with the team lead

1. Write a brief, e.g. `phases/briefs/feature-x.md`: the goal, users, constraints, what is out of scope.
2. `team unpack phases/briefs/feature-x.md --out phases/phase-02`
   The lead reads PRD/ROADMAP/phases, writes `phases/phase-02/README.md` plus one story file per story, and ends with
   open questions and decisions for you.
3. Read the files. Answer the questions **in the brief** (add an "Answers" section) or edit the plan directly, then
   run the same `team unpack` again; the lead revises the files. Repeat until you are happy.
4. Commit the plan: `git add -A && git commit -m "Plan: feature X"`.

## Workflow 2 - develop one story

```bash
S=phases/phase-02/stories/P02-S01-something.md
team review $S      # 1. lead reviews the story and fixes it in place (offers to commit its edits)
                    #    -> APPROVED, or questions only you can answer
team dev $S         # 2. dev implements -> unit tests -> QA -> (one repair round)
                    #    succeeded -> go to 4;  failed -> 3
team fix $S         # 3. dev fixes QA's findings (and the failing tests)
team qa $S          #    you run the tests here, QA reviews the diff + results
                    #    repeat fix / qa until "QA passed"
team final $S       # 4. lead final review; if complete it marks the story Done (ticks, Evidence)
                    #    and proposes the commit message
                    #    changes requested -> team fix / team qa again, then team final
team commit $S      # 5. shows the files and message, asks, then commits
```

Rules the helper enforces: `dev` needs the lead's approval (or `--force`) and a clean working tree (commit or stash
first); `final` needs QA passed; `commit` needs the lead's final approval. Per-story state (base commit, findings,
verdicts, commit message) lives in `~/.local/state/agent-studio/project-team/`.

The story's Status/Evidence update made by the lead in `final` is included in the `team commit`.

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

## Doing it by hand (what team.py runs)

```bash
agent-studio snapshot --team $TEAM --pretty                       # IDs and status
agent-studio task direct --team $TEAM --agent $LEAD --policy read_only \
    --text "REVIEW A STORY BEFORE WORK. Story file: $S" --wait --pretty
agent-studio workflow start --team $TEAM --developer $DEV --reviewer $QA \
    --text "Implement the story in $S ..." --wait --pretty
agent-studio workflow show --workflow $WF --pretty                # stages, diff path, test output, QA verdict
```
