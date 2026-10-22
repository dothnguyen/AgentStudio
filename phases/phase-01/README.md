# Phase 01 — Configurable workflows

> Status: Planned, rev 3 (2026-10-22): adds Epic E4, session continuity
> Briefs: [feature-configure-workflow.md](../briefs/feature-configure-workflow.md) (E1–E3, gate S10) · [feature-workflow-session-context.md](../briefs/feature-workflow-session-context.md) (E4, S11–S18)
> Product: [PRD.md](../../PRD.md) §6b · Delivery: [ROADMAP.md](../../ROADMAP.md) · Stories: [stories/README.md](./stories/README.md)

## Goal

Replace P00's hard-wired Developer → Reviewer workflow with workflow **definitions** the operator writes in JSON or YAML: an ordered list of stages, each naming the role that does it, its permission level, its prompt template, and where each outcome goes next (for example QA `fail` → Developer, QA `pass` → TeamLead, TeamLead `fail` → Developer). The operator then tells the team to run a named definition with one prompt, and the coordinator drives it with the same durability, safety, and evidence guarantees P00 proved.

P01 covers the backend and CLI only. The Electron command center moves to P02, where it reads these runs over `serve` like every other run.

## Open questions and the assumptions this plan uses

| # | Question | Assumption until answered |
|---|---|---|
| Q1 | YAML needs a parser, but the backend uses only the Python standard library. Add PyYAML, or parse YAML ourselves? | We write a **strict YAML subset** parser on the stdlib (S02). Anything outside the subset is rejected with a line number and never guessed. JSON is the canonical form. |
| Q2 | How does a stage's role find an agent? | Through the roster's `role` field: exactly one agent in the team has that role. `--bind Role=agent` overrides it. No match → `ROLE_UNBOUND`; several matches → `ROLE_AMBIGUOUS`. |
| Q3 | May one agent serve two roles in the same run? | No. Distinct roles bind to distinct agents (`SAME_AGENT`), as in P00, so a reviewer never reviews its own work. |
| Q4 | Is the deterministic test command (P00 validation) still part of workflows? | Yes, as a stage of `type: validation` with outcomes `pass` and `fail`. Its argv still comes from `.agent-studio/workflow.json`. Definitions cannot carry commands. |
| Q5 | How are loops bounded? | Each stage has `maxVisits` (default 1, max 10) and each definition has `maxSteps` (default 20, max 100). Exceeding either **fails** the run and records the reason. No loop is unbounded. |
| Q6 | What happens when an agent fails, times out, or returns no verdict? | Same as P00: the run **pauses** and the operator resolves it (`assignment.resolve` / `workflow.cancel`). Routing follows only real outcomes (`done`, `pass`, `fail`). |
| Q7 | Does the P00 built-in workflow survive? | Yes. It becomes a built-in definition, `developer-reviewer`, with P00's stage names unrolled (no loop), so the P00 `workflow start --developer --reviewer` form behaves as before. |
| Q8 | What about P00 workflow runs that are still active when the backend is upgraded? | They are never killed. Once their current step ends they pause with `LEGACY_WORKFLOW_RUN`, and the only command they accept is `workflow.cancel`. Operators should finish P00 runs before upgrading. |
| Q9 | What is the P01 gate: one real provider, or two different ones? | One real run of a three-role definition with real providers in a disposable fixture. Any ready provider counts (this project's team is all Claude today). The fail → back-to-Developer loop is proven deterministically with the fake adapter. |
| Q10 | Parallel stages, conditions on text, per-stage commands, per-stage deadlines, a visual editor? | Out of scope for P01 (see Non-goals). |

## Epics → stories

| Epic | Story | Deliverable |
|---|---|---|
| E1 Definition format | [P01-S01](./stories/P01-S01-definition-model-and-json.md) | Definition model, JSON loader, static validation |
| | [P01-S02](./stories/P01-S02-yaml-subset-loader.md) | Strict YAML subset loader that produces the same model |
| | [P01-S03](./stories/P01-S03-prompt-templates.md) | Prompt templates: placeholders, prompt files, verdict footer |
| E2 Generic engine | [P01-S04](./stories/P01-S04-schema-binding-and-start.md) | Schema migration, role binding, frozen definition, first-stage dispatch |
| | [P01-S05](./stories/P01-S05-routing-and-bounds.md) | Agent-stage outcomes, routing, `maxVisits` / `maxSteps`, diffs, `routed` events |
| | [P01-S06](./stories/P01-S06-validation-stages-and-builtin.md) | Validation stages, `passRequires`, built-in `developer-reviewer`, P00 compatibility |
| | [P01-S07](./stories/P01-S07-recovery-resolve-cancel.md) | Restart, resolve, cancel, and deadlines for definition runs |
| E3 Run with a prompt | [P01-S08](./stories/P01-S08-workflow-commands.md) | `workflow list / validate / start --definition / show` over the CLI and `serve` |
| | [P01-S09](./stories/P01-S09-project-workflow-and-team-run.md) | Project definition `story-delivery.yaml` and `team.py run NAME "prompt"` |
| Gate | [P01-S10](./stories/P01-S10-live-gate.md) | Real run of a three-role definition with real providers |
| E4 Session continuity | [P01-S11](./stories/P01-S11-adapter-session-contract.md) | Adapter session contract, fake resume, resume prompt, one fresh fallback, normalized usage |
| | [P01-S12](./stories/P01-S12-session-store-and-decision.md) | `agent_sessions` table, `sessionKey` on `task.direct`, decision frozen at assignment creation, pointer advance |
| | [P01-S13](./stories/P01-S13-session-end-and-visibility.md) | `session.end` / `session.list`, `team.stop` ends sessions, `snapshot` / `task show` visibility |
| | [P01-S14](./stories/P01-S14-workflow-session-keys.md) | `workflow.start` `sessionKey`, run ID as the default key, repair resumes the same session |
| | [P01-S15](./stories/P01-S15-claude-session-resume.md) | Claude Code `--resume` + `--fork-session`, verified on the real CLI (permissions, fallback, model) |
| | [P01-S16](./stories/P01-S16-team-py-sessions-and-usage.md) | `team.py`: story keys, `reset`, end on `commit`, `usage` |
| E4 gate | [P01-S17](./stories/P01-S17-session-live-evidence.md) | Real story cycle with a fix round: resumed sessions, usage comparison, every fresh-start trigger |
| Follow-up | [P01-S18](./stories/P01-S18-codex-session-resume.md) | Codex `exec resume` permission mapping (not part of the phase exit; may end Blocked) |

Order: S01 → (S02 and S03 in parallel) → S04 → S05 → S06 → (S07 and S08 in parallel) → S09 → S10.

E4 does not depend on E1–E3: S11 → S12 → (S13, S14, S15 in parallel) → S16 → S17. **Recommended: do E4 first.** This project's own P01 stories are delivered with `team.py`, so every later story then runs with resumed sessions. The cost is that S04's table rebuild has to keep `workflow_runs.session_key` and the generic engine has to pass the key on (§H; a guard test from S14 catches a miss).

## E4 — Session continuity: open questions and assumptions

Goal: during one story's cycle (`review` → `dev` workflow → `fix`/`qa` rounds → `final` → `commit`), each agent continues its **own** provider conversation from task to task instead of starting cold. Between stories, after `team reset`, after `team commit`, and after a team stop or restart, agents start fresh.

| # | Question (brief) | Assumption this plan uses |
|---|---|---|
| SQ1 | New phase, or stories in an existing phase? | **Epic E4 of P01** (S11–S18). The brief's "before the P01 desktop UI" is out of date: the UI is now P02, so P01 is already before it. Nothing in E4 needs E1–E3. This moves "session resume" forward from ROADMAP P04. |
| SQ2 | After a failed, timed-out or cancelled task: resume that session, or start fresh? | **Neither: resume from the last *succeeded* task.** Each resumed run **forks** (Claude `--fork-session`), so the stored session never changes in place. The session pointer moves only when a `succeeded` report is applied. A failed, timed-out, cancelled, `waiting_input`, `inconclusive` or `reconciling` task leaves the pointer where it was, so the next task resumes the last good state, and the resume note tells it that files may have changed. An adapter that cannot fork ends the session after any resumed task that did not succeed (the next task starts fresh). |
| SQ3 | Should QA keep its session across fix rounds? | **Yes** (the brief's default). `team.py reset qa STORY` gives an unbiased fresh review when wanted. |
| SQ4 | Should the built-in repair round resume the developer's session? | **Yes.** It happens without extra rules, because every stage of a run carries the run's key. |
| SQ5 | Cap on session size? | **Yes.** A session rotates to fresh after **12 tasks** or when the last result's context (input + cached tokens) exceeds **160 000**. Both are configurable per workspace in `.agent-studio/team.json` → `"sessions": {"maxTasks", "maxContextTokens"}`, frozen at `team.start`. Rotation is an event plus a warning, never silent. |
| SQ6 | (lead) Where does the fresh fallback happen? | **In the runner, within the same assignment**, and only when the adapter classifies the run as `PROVIDER_SESSION_MISSING` (the provider refused to load the session before any turn). The request already carries everything needed for both prompts, so the runner decides nothing new. |
| SQ7 | (lead) Codex? | Declares `resume: unsupported`. Keyed tasks run as today (fresh, `--ephemeral`), with the warning `SESSION_CONTINUATION_UNSUPPORTED`. Verifying the mapping is follow-up S18, outside the phase exit. |

## Design contract

Every P01 story targets this section as its "Architecture". It extends the [P00 implementation contract](../phase-00/architecture.md), and everything there still holds: write authority, the Windows↔WSL boundary, the permission vocabulary, process identity, and no shell for user text. A story that changes a rule here updates this section in the same change.

### A. Where definitions live and how they are named

- Definitions live in `<workspace>/.agent-studio/workflows/<name>.json`, `<name>.yaml`, or `<name>.yml`. `<name>` matches `[a-z0-9][a-z0-9-]{0,63}`, and the file stem **is** the name. Lookup always checks all three extensions; two files with the same stem → `WORKFLOW_DEFINITION_AMBIGUOUS` (from S01; YAML parsing itself arrives in S02).
- One built-in definition, `developer-reviewer`, ships as `backend/agent_studio/workflows/developer-reviewer.json`. A workspace file with that name → `WORKFLOW_DEFINITION_INVALID` (the name is reserved).
- Files are read once at `workflow.start`. The parsed definition is frozen into the run (canonical JSON plus the SHA-256 of the source bytes), so editing a file never changes a run already started. This is the same rule P00 §F applies to roles.
- Limits: 64 KiB per definition file, 20 stages, 32 KiB per prompt template. **`promptFile` paths are relative to `<workspace>/.agent-studio/`** (the same base as `roles.json`), so `promptFile: prompts/develop.md` is `.agent-studio/prompts/develop.md`; for a built-in definition the base is the built-in folder (`backend/agent_studio/workflows/`, passed to the loader as `builtin_dir`). Path rules match roles: the file stays inside its base (no `..`, no absolute paths, no symlink escapes).
- **Frozen form.** What a run stores is not the source file but canonical JSON (sorted keys, defaults filled in): each agent stage's template text inlined as `prompt` with its origin in `promptSource` (`"inline"` or the `promptFile` path; `promptFile` itself never appears), plus top-level `name`, `sourceSha256` (SHA-256 of the definition file's bytes) and `warnings`. The source form and the frozen form have separate readers (`parse_obj` and `from_json`); each rejects the other's extra keys, and the frozen form round-trips byte for byte.
- Modules: `backend/agent_studio/workflowdef.py` (model, loading, validation), `yamlsubset.py` (YAML), `prompts.py` (rendering). `workflow.py` remains the engine.

### B. Definition format (version 1)

The example is YAML; JSON has the same structure.

```yaml
version: 1
description: Developer implements, tests run, QA reviews, TeamLead signs off.
maxSteps: 16                    # optional, default 20, max 100
stages:                         # ordered; the run starts at the first stage
  - id: develop
    role: Developer             # roster role that does this stage
    permission: workspace_write # read_only | workspace_write
    maxVisits: 3                # optional, default 1, max 10
    promptFile: prompts/develop.md
    next: { done: tests }       # work stage: one outcome, "done"
  - id: tests
    type: validation            # coordinator runs .agent-studio/workflow.json validation.argv
    maxVisits: 3
    next: { pass: qa, fail: qa }
  - id: qa
    role: QA
    permission: read_only
    maxVisits: 3
    passRequires: [tests]       # a QA "pass" counts only if the latest "tests" result passed
    prompt: |
      Review DIFF against TASK, taking VALIDATION into account.
      {{task}}
      {{diff}}
      {{validation}}
    next: { pass: final, fail: develop }
  - id: final
    role: TeamLead
    permission: read_only
    maxVisits: 2
    promptFile: prompts/final-review.md
    next: { pass: $succeed, fail: develop }
```

The loader (S01) checks all of these rules statically:

- `id` matches `[a-z][a-z0-9_]{0,31}` and is unique. `type` is `agent` (the default) or `validation`.
- An agent stage needs `role`, `permission`, and exactly one of `prompt` / `promptFile`. A validation stage has none of these.
- `next` is required on agent stages, and its keys decide the stage kind: `{done}` makes a **work stage** (no verdict expected); one or both of `{pass, fail}` makes a **verdict stage**. Mixing `done` with `pass`/`fail` is an error. On validation stages `next` is optional and takes `{pass, fail}`. A missing `pass` defaults to the next stage in the list (or `$succeed` after the last stage), and a missing `fail` defaults to `$fail`.
- A target is a stage `id`, `$succeed`, or `$fail`. Every stage must be reachable from the first, and `$succeed` must be reachable.
- `passRequires` is allowed only on verdict stages and lists validation stage ids.
- The key is `next`, not `on`, because YAML 1.1 parsers read `on:` as boolean `true`.
- Unknown keys are errors, not warnings. All errors in a file are reported together as `WORKFLOW_DEFINITION_INVALID` with `data.errors`, each `{file, path, line, message}`:
  - `file`: the definition file relative to the workspace (or `builtin:<name>.json`);
  - `path`: the JSON path of the offending value (`stages[2].next.fail`, `stages[0].promptFile`), or `$` for whole-file errors (size limit, invalid UTF-8, syntax error, duplicate key, top level not an object);
  - `line`: the source line for YAML (S02) and for JSON syntax errors, otherwise `null`;
  - `message`: the rule broken; for a duplicate key it names the key and its object (`duplicate key "next" in stages[1]`).
  Warnings use the same shape in `data.warnings`.
- Warnings (non-fatal): a stage that can be re-entered but has `maxVisits: 1`, and a `read_only` stage whose prompt never mentions `{{diff}}` while some `workspace_write` stage precedes it.

### C. Prompts

A stage prompt is the role context the runner already adds (P00 §F), then the rendered template, then a fixed footer.

- Placeholders: `{{task}}` (the operator's prompt), `{{diff}}` (the latest captured diff against the base commit), `{{validation}}` (the latest validation result and its bounded output), `{{findings}}` (the findings of the verdict that routed the run here), `{{summary}}` (the summary of the previous agent stage), `{{stage}}`, and `{{visit}}`. An unknown placeholder is a load error.
- Each data placeholder expands to a bounded `===== NAME ===== … ===== END NAME =====` section with P00's limits: task 32 KiB, diff 256 KiB, validation 32 KiB, findings 16 KiB, summary 16 KiB. When nothing exists yet, the section says so (`(no changes)`, `(not run yet)`, `(none)`). Expansion is **single pass**: text inside the data is never expanded again, executed, or put on a command line.
- If a template does not mention `{{task}}`, the TASK section is appended, so no stage runs without the operator's goal.
- Verdict stages get a fixed footer asking for exactly one final JSON line, `{"verdict": "pass"|"fail", "findings": [...]}`. This is the contract P00 already parses, and the footer means a template cannot forget it.

### D. Engine semantics

- **Binding.** At `workflow.start` each distinct role is bound to one agent of the team (Q2, Q3). Every bound agent must be alive, and its adapter must have a verified mapping for every permission its stages use (`POLICY_UNSUPPORTED` otherwise). Bindings are frozen into the run.
- **Start.** Same preconditions as P00: a running team, a git repository root with a commit, a clean tree (debug `allowDirtyTree` kept), a valid `workflow.json`, and no other mutating work (`WORKSPACE_BUSY`). The run records the base commit and dispatches the first stage.
- **One stage at a time.** Stages run strictly in sequence, and a run holds the workspace for its whole lifetime.
- **No role or stage names in code.** The engine never branches on a role name, a stage id, or a provider ID. A guard test enforces this, extending P00's provider-name guard.
- **Outcomes.**

| Stage result | Outcome / action |
|---|---|
| agent `succeeded`, work stage | `done` |
| agent `succeeded`, valid verdict | `pass` or `fail`. A `pass` whose `passRequires` result failed or is missing becomes `fail`, with a finding that names the validation stage. |
| agent `succeeded`, missing or malformed verdict | run **paused** (`MALFORMED_VERDICT`) |
| agent `failed` / `inconclusive` / `waiting_input` / `reconciling` | run **paused** with the diagnostic code |
| validation exit 0 / nonzero or timeout | `pass` / `fail` |
| validation could not run / lost | run **paused** (`VALIDATION_ERROR` / `VALIDATION_LOST`) |
| agent `cancelled`, or operator cancel | run **cancelled** |

- **Routing.** The outcome selects `next[outcome]`, and `$succeed` / `$fail` end the run. The run ends `failed` with the reason when it would enter a stage whose visit count already equals `maxVisits`, or would take step `maxSteps + 1`. A resolve-retry of the same stage is a new attempt, not a new visit, and not a new step.
- **Diffs.** After every successful `workspace_write` stage the coordinator captures `git diff <base>` plus the untracked-file list, exactly as P00 does. `{{diff}}` uses the latest capture.
- **Task status.** The run's task is `running` during work and validation stages and `review` during verdict stages. Its final status equals the run's.

### E. Commands

| Command | Args | Notes |
|---|---|---|
| `workflow.list` | `teamId` or `workspace` | Read-only. Lists built-in and workspace definitions with name, description, stage ids, roles, and load errors. |
| `workflow.validate` | `teamId` or `workspace`, `definition` | Read-only. Runs the full static check, plus role binding against the team when `teamId` is given. Returns errors and warnings. |
| `workflow.start` | `teamId`, `definition`, `text` (≤ 32 KiB), `bindings?` `{role: agentId}` | Mutating, needs an idempotency key. The P00 form (`developerAgentId`, `reviewerAgentId`, no `definition`) means the built-in `developer-reviewer`. |
| `workflow.show` / `workflow.cancel` | `workflowRunId` | `show` adds the definition name and SHA-256, bindings, visits per stage, step count, and the route taken. |

CLI: `agent-studio workflow list|validate|start ...`, with `start` taking `--team ID --definition NAME (--text TEXT | --text-file PATH|-) [--bind ROLE=AGENT ...] [--wait]`. `--workflow` still means a run ID. New error codes: `WORKFLOW_DEFINITION_NOT_FOUND`, `WORKFLOW_DEFINITION_INVALID`, `WORKFLOW_DEFINITION_AMBIGUOUS`, `ROLE_UNBOUND`, `ROLE_AMBIGUOUS`.

### F. State and events

- **Migration (S04).** `workflow_runs` and `stage_attempts` are **rebuilt** (create new table, copy, drop, rename, in one transaction), because SQLite cannot drop the P00 `CHECK (stage IN …)`, `CHECK (current_stage IN …)`, and `CHECK (retry_count <= retry_budget)` constraints. Stage ids are then checked by the engine against the frozen definition. Existing rows are copied unchanged. New columns: `workflow_runs.definition_name`, `definition_json`, `definition_sha256`, `bindings_json`, `step_count`; `stage_attempts.stage_type`, `visit`. `developer_agent_id` / `reviewer_agent_id` stay for old rows, but the definition engine no longer reads them.
- **Events.** A new event, `workflow_run.routed` `{fromStage, outcome, toStage, reason, sourceAssignmentId}`, is written on every transition, including to `$succeed` / `$fail`. P00 events (`handoff`, `validating`, `validated`, `verdict`, `paused`) keep their names and fields. `repair_requested` is still emitted when routing returns to an already-visited stage, and `retry_count` counts those revisits.

### G. Upgrade and compatibility

- The P00 command form maps to the built-in definition, which unrolls P00 exactly: `developer` → `validation` → `reviewer` (pass → `$succeed`, fail → `developer_repair`) → `validation_recheck` → `reviewer_recheck` (pass → `$succeed`, fail → `$fail`). The reviewer stages use `passRequires` on their validation stage. Every P00 truth-table row therefore gives the same result, and the stage names stay the same.
- P00 runs active at upgrade (rows with no `definition_json`) follow Q8: they pause with `LEGACY_WORKFLOW_RUN` once their current assignment or validator is terminal, and only `workflow.cancel` is accepted. They are never killed or silently failed.

### H. Session continuity (E4)

This replaces P00 §G's "agents are stateless" for **keyed** tasks only. Correctness never depends on a resume: every prompt still carries the task, the diff and the findings explicitly.

- **Session key.** `task.direct` and `workflow.start` accept an optional `sessionKey` matching `[A-Za-z0-9][A-Za-z0-9._-]{0,95}` (`SESSION_KEY_INVALID` otherwise). A workflow run without one uses its run ID. Every assignment of a run carries the run's key: stages, repairs, resolve-retries. Without a key, behaviour is exactly as today: a fresh session and nothing persisted (Claude keeps `--no-session-persistence`).
- **Scope.** A session belongs to one `(agent, sessionKey)` pair. Agents never share one, and keys never cross. A new team has new agent IDs, so nothing carries over a team restart.
- **State (S12 migration).** New table `agent_sessions`: `id`, `team_id`, `agent_id`, `session_key`, `status` (`active` | `ended`), `provider_id`, `model`, `reasoning`, `provider_session_id`, `task_count`, `last_assignment_id`, `last_usage_json`, `created_at`, `updated_at`, `ended_at`, `end_reason`. At most one `active` row per `(agent_id, session_key)` (partial unique index). `workflow_runs.session_key` is a new column. **P01-S04's table rebuild must copy it.**
- **Decision at assignment creation.** `tasks.build_request` is the single path (direct, workflow stage, resolve-retry, verify). It calls `sessions.decide` and freezes `request.session = {key, mode, resumeFrom, persist, reason}`:

| Situation | `mode` | Effect |
|---|---|---|
| no key | `none` | as today |
| adapter `session_support().resume` false | `unsupported` | fresh, nothing persisted; warning `SESSION_CONTINUATION_UNSUPPORTED` on the receipt and in `assignment.created` |
| no active row, or a row with no provider session yet | `fresh` | full role context; persistence on |
| active row, same model and reasoning, under the caps | `resume` | `resumeFrom` = the row's `provider_session_id` |
| caps exceeded, or model/reasoning differ | `fresh` | old row ended (`rotated: max_tasks` / `max_context` / `settings_changed`) |

- **The runner follows the request.** On `resume`, the prompt is a fixed `===== AGENT STUDIO SESSION =====` note, then a one-line role reminder, then the task or stage prompt. The note says: you are continuing your earlier session for KEY; files may have changed since you read them, so re-read anything you rely on; your permission for this task is POLICY. The full role and skill block is not repeated. **Policy flags always come from the current task's policy.**
- **Fallback (once).** If the adapter classifies a resume run as `PROVIDER_SESSION_MISSING` (no turn ran), the runner moves its evidence to `runs/<id>/resume-attempt/`. It then runs the same assignment once fresh, with the full prompt, the same model, reasoning and policy, and the remaining deadline. The report's `session` says `{mode: "fresh", fallbackFrom, warning}`. There is never a second fallback.
- **Pointer advance happens only in the coordinator, when it applies a report.** It applies when the report is `succeeded`, `persist` is true, the row is still active and a `providerSessionId` was reported: the pointer becomes the reported ID, `task_count` goes up by 1, `last_usage` is recorded, and a `session.advanced` event is written. Every other outcome leaves the pointer alone and writes `session.not_advanced {status}`. An adapter without `forkOnResume` ends the row instead (`unsafe_after_failure`). A fallback writes `session.fallback` and re-points the row. A report applied after a restart from `result.json` counts. A `reconciling` attempt never advances, and its resolve-retry decides from the last proven pointer.
- **Ending.** `session.end {teamId, agentId?, sessionKey?}` ends the matching active rows (`operator`). With neither filter it needs `all: true`. It answers `SESSION_IN_USE` while a matched agent has an active assignment carrying the key. `team.stop` ends all the team's rows (`team_stopped`) in its own transaction. Ended rows are never resumed. Agent Studio never deletes the provider's own session files.
- **Usage.** Adapters add `usageNormalized {inputTokens, cachedInputTokens, outputTokens}` (uncached input, cache reads, output) and, where they can see them, `toolUses {name: count}`. The raw `usage` is kept. Caps use `inputTokens + cachedInputTokens` of the last result.
- **Visibility.** `snapshot` adds `sessions[]` (agent, key, status, providerSessionId, taskCount, lastUsage). `task show` adds a `session` block to each assignment (mode, resumeFrom, providerSessionId, fallback, warning). New read command: `session.list {teamId, sessionKey?}`.
- **Events.** `session.started`, `session.advanced`, `session.not_advanced`, `session.fallback`, `session.rotated`, `session.ended`, each with team, agent, key and assignment IDs.
- **No provider names outside adapters.** The coordinator reads only `session_support()` (`resume`, `forkOnResume`). The existing provider-name guard test covers `sessions.py`.

## Non-goals for P01

Electron UI (P02), visual workflow editing, parallel or fan-out stages, conditions on text or expressions, stages that run arbitrary commands, per-definition validation commands, per-stage deadlines, workflows that span workspaces, interactive reply to provider prompts, and an unrestricted permission level. For E4: one long-running provider process per agent (stream-json input), sharing context between agents, keeping context across stories or team restarts, and Codex resume until S18 verifies it.

## Phase exit

P01 is Done when S01–S09 and S11–S16 are Done with evidence, [P01-S10](./stories/P01-S10-live-gate.md) records a real run of a three-role definition with real providers in a disposable fixture, and [P01-S17](./stories/P01-S17-session-live-evidence.md) records a real story cycle with resumed Claude sessions. Fake-adapter tests prove the routing, the bounds and the session rules, but they never replace the real runs. S18 (Codex resume) is a follow-up: it may be Done, Blocked with a recorded gap, or carried into a later phase.
