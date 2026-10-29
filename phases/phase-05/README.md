# Phase 05 — Workspace dashboard redesign v2

## Goal

Redesign Home into the compact operational overview in [the visual reference](../../design/workspace-dashboard-v2.png), while preserving the dark theme, navigation, and read-only dashboard behavior. Operators should scan real workspace, team, board, and activity data quickly at desktop and narrow widths.

## Open questions and assumptions

- **Question:** Should “open” and “completed” cover every board phase? **Assumption:** No; `board.summary` returns the effective current phase only, so cards say “Current phase” and derive open from non-`done`/`closed` columns and completed from `done`/`closed` columns. No cross-phase value is claimed.
- **Question:** Should the five pictured agent portraits and a phase description be shown? **Assumption:** No; `team.list` exposes aggregate availability, member count, and assignment count, but not individual identities/presence; `board.summary` has phase name/status but no description. Use aggregate presence labels and phase name/status. Do not invent portraits or copy.
- **Question:** Which team should the panel emphasize when several exist? **Assumption:** Show a compact list of all returned teams, led by running teams, with a truncation notice when `team.list` says so. Never imply a single team represents the workspace.
- **Question:** What counts as “last updated”? **Assumption:** The last complete successful refresh of all three sections; keep the prior timestamp when any section fails and label partial/stale data clearly. This needs coordinated response tracking in the renderer, not a new backend command.

## Architecture

The existing renderer uses `WorkspaceShell.tsx` and `navModel.ts` for navigation, `DashboardHome.tsx` for composition, `useDashboardSection.ts` for per-section loading and stale-response protection, and `TeamsPanel.tsx`, `BoardPanel.tsx`, `ActivityPanel.tsx` for read-only content. `DashboardApi` in `app/src/renderer/api.ts` exposes `teams(workspaceId)`, `board(workspaceId)`, and `activity(workspaceId)`, mirrored in `app/src/shared/api.ts`; existing IPC maps those to `team.list`, `board.summary`, and `activity.recent`. The Home activity panel calls `activity.recent` with `{ limit: 15, kinds: ['ticket'] }`, so it lists ticket events only (moved, outcome applied, merged); the backend filters by kind before applying `limit`, and callers that omit `kinds` still get all kinds (`team`, `assignment`, `workflow`, `ticket`). Preserve these contracts and the allowlisted preload surface. `board.summary` contains current phase, configured status columns with counts/kinds, totals, and a bounded ticket projection; `team.list` contains up to 50 definitions, optional runtimes, aggregate availability, and `truncated`; `activity.recent` contains bounded entries with `summary`, `kind`, and ISO `at`. The sketch's numbers are illustrative; every rendered value must come from these responses or be explicitly unavailable.

Use the current CSS tokens and responsive foundations in `app/src/renderer/styles.css`. Keep one main landmark, one Home `h1`, panel `h2`s, text alongside status colors, native buttons for navigation/refresh/retry, and independent section errors. Existing destination placeholders remain outside scope.

## Epics → stories

| Epic | Story | Outcome |
|---|---|---|
| Shell and identity | [P05-S01](./stories/P05-S01-shell-and-header.md) | Compact sidebar and overview header |
| Scan metrics | [P05-S02](./stories/P05-S02-summary-metrics.md) | Four truthful summary cards |
| Operational panels | [P05-S03](./stories/P05-S03-board-status.md) | Current-phase board progress and counts |
| | [P05-S04](./stories/P05-S04-team-status.md) | Team runtime and aggregate availability |
| | [P05-S05](./stories/P05-S05-activity-feed.md) | Structured recent activity feed |
| State integrity | [P05-S06](./stories/P05-S06-refresh-coordination.md) | Truthful full-refresh timestamp and race handling |
| Finish | [P05-S07](./stories/P05-S07-responsive-accessibility.md) | Narrow-width and accessibility polish; full validation |

Dependencies allow the three panels to land independently after the shell, while the final validation story follows the whole layout.

## Teams management screen — T-037

**Goal.** Turn the approved Teams management concept into a workspace-scoped screen for reusable agents, team membership, live operation, and board routing. Every displayed value and action must reflect workspace configuration or runtime evidence.

**Goal, restated.** Operators can maintain reusable agent definitions and assemble teams while seeing each member's provider, model, availability, and current work. They can configure worktree and routing policy and control a live team board from the Teams screen, with Team Lead assigned to merge conflicts.

### Open questions and planning assumptions

| Question | Assumption for this story set |
|---|---|
| Where is `design/teams-screen-v1.png`? | It is absent from this checkout. Treat the ticket's enumerated capabilities as the approved functional reference; visual details require the image before visual acceptance. Pictured names, counts, providers, statuses, and models are illustrative only. |
| Is an agent definition shared across workspaces? | Scope the catalog to one workspace under `.agent-studio/`, consistent with teams, roles, workflows, and board configuration. Team members reference stable catalog ids; editing a catalog entry updates future starts, while a running roster remains frozen. |
| Can a member override a reusable agent definition? | Keep a member's identity and role in the team; use the catalog's provider/model/reasoning defaults. An explicit team override needs a later product decision. Existing inline members remain readable and editable during migration. |
| What does “merge on success” mean? | Show and edit the existing board action rule's merge behavior and worktree mode; never imply every workflow success merges. Preserve the board's outcome applier and safety checks. |
| Which board can the screen control? | The current workspace's one board and its selected running team. Start/stop reflect `board.run`/`board.stop`; a stopped or disconnected board is shown as such. |
| Are role descriptions editable here? | Read them from `roles.json` and offer workspace-scoped editing through a validated API. Role ids used by workflows and board rules remain stable unless explicitly migrated. |
| How are rules edited? | Edit the configured status → role → workflow → next-status graph using validated `board.json` writes. Keep action rules visible and protect merge-conflict and plan-merge-conflict routing to TeamLead in this workspace's default configuration; show validation errors rather than silently rewriting rules. |

### Architecture and gaps

`WorkspaceShell.tsx` already routes to a Teams placeholder, and the Home `TeamsPanel` links there. Reuse its shell, tokens, status labels, section loading pattern, and allowlisted preload/IPC boundary. `team.list` only returns a bounded definition summary plus aggregate runtime; it has no member identities, provider/model, role descriptions, or current assignment details. `board.summary` is read-only and omits the rule graph and board runner state. `teamdefs.py` stores inline members and has add/remove but no reusable agent catalog or general edit contract. `roles.json`, `board.json`, `team.status`, `board.show`, `board.run`, and `board.stop` supply foundations; safe workspace-scoped reads/writes, validation, and desktop IPC are still needed. The current board rules already route both `merge-conflict` and `plan-merge-conflict` to `TeamLead`; maintain that explicit mapping.

### Epics → stories

| Epic | Story | Outcome |
|---|---|---|
| Management contracts | [P05-S08](./stories/P05-S08-agent-catalog.md) | Reusable workspace agent definitions |
| | [P05-S09](./stories/P05-S09-team-edit-contract.md) | Team creation and membership against catalog definitions |
| | [P05-S10](./stories/P05-S10-management-read-model.md) | Member, role, provider/model and truthful live state projection |
| | [P05-S11](./stories/P05-S11-board-settings-contract.md) | Validated worktree, merge, routing, and board-control contracts |
| Desktop boundary | [P05-S12](./stories/P05-S12-management-ipc.md) | Typed, allowlisted management IPC |
| Teams UI | [P05-S13](./stories/P05-S13-teams-screen.md) | Team and reusable agent overview |
| | [P05-S14](./stories/P05-S14-team-membership-ui.md) | Team and member editing |
| | [P05-S15](./stories/P05-S15-live-team-controls.md) | Live status and board controls |
| | [P05-S16](./stories/P05-S16-routing-settings-ui.md) | Worktree, merge and routing editor |
| Acceptance | [P05-S17](./stories/P05-S17-teams-live-gate.md) | Responsive, accessible, Windows plus WSL live validation |

These ten stories form one dependency-ordered delivery set. Child tickets stay in backlog while this planning worktree is merged; the existing `plan-merge-ready` rule promotes this run's children to `refine-ready` after a successful merge.

## Multi-agent member options — T-048

Operators can manage each team member's ordered catalog agent options and switch the active runtime agent without restarting the team. The coordinator remains authoritative for live selection, quota holds and board work while saved edits apply on a future start.

All assumptions for this work are fixed by T-048; there is no open product question. Keep the existing team table and edit form, add an ordered options editor inside the member form, and add live option/hold actions in the selected member row/detail. `design/teams-screen-v1.png` remains authoritative for hierarchy, not its single provider/model cell.

### Verified contracts and gaps

- `backend/agent_studio/teamdefs.py` validates `member.agents` as a non-empty, ordered, duplicate-free list of existing catalog ids, incompatible with `agent`, `provider`, `model`, or `reasoning`. `resolve_member(member: dict, catalog: dict)` returns ordered agents; `member_add(workspace: str, team_id, fields: dict, active)` and `member_update(workspace: str, team_id, member_id: str, changes: dict, active)` accept `agents`.
- `backend/agent_studio/dispatch.py` allowlists `agents` in `teamdef.member.add/update`. `_validate_agent_switch(args)` accepts only `workspace`, `teamDefId`, `memberId`, `agent`, `cancelActive`, `assignmentId`; `_validate_member_resume(args)` accepts only `workspace`, `teamDefId`, `memberId`, `agent`.
- `backend/agent_studio/teams.py` already supplies `switch_member_agent(tx: Tx, args: dict, ctx: dict) -> dict`, `resume_member_agent(tx: Tx, args: dict) -> dict`, `handle_quota_limit(tx: Tx, agent_id: str, reset, ctx: dict) -> None`, `recover_expired_quotas(store: Store, ctx: dict) -> None`, and `complete_pending_switches(store: Store, ctx: dict) -> None`. Reuse their cancellation, failover, quota and board recovery behavior.
- `team.member.switch` returns `{teamId, memberId, agentId, activeAgent, provider}` immediately or `{teamId, memberId, agentId, pendingAgent, assignmentId, cancellation}` after cancellation is requested. `team.member.resume` returns `{teamId, memberId, agentId, option, cleared, activeAgent}`. `team.status` currently exposes `memberId`, `name`, `role`, `provider`, `agentId`, `availability`, `activeAgent`, `quotaHolds`, `pendingAgent`, `paneState`, and `assignment`.
- Preserve these exact errors: "Member has an active assignment; confirm cancellation of this assignment to switch." with `error.data.assignmentId`; "A switch is already pending for this member."; "Agent '<id>' is on quota hold."; "That agent is already active; use board resume when its quota resets."; "The member's pane is not alive."; "Member must be idle or quota-limited before switching."; "Agent '<id>' is not configured for member '<id>'."; "Agent '<id>' is missing from the catalog." Provider failure is `PROVIDER_UNAVAILABLE` with "Provider '<provider>' is not ready: <reason>".
- Existing `tests/unit/test_member_agent_switch.py`, `tests/integration/test_member_agent_switch.py`, and `tests/unit/test_p04_s10_scheduler.py` cover switching, failover/exhaustion, both resume cases, persistence, exact-assignment cancellation, same-member recovery and quota retry without an ordinary failure round. Extend them only for gaps.

The remaining gaps are: (1) live operations reread mutable definitions instead of a frozen start-time option list; (2) status has `pendingAgent` but no durable last switch result, although completion/failure events exist; (3) `teamview.py` and `app/src/shared/management.ts` lack all resolved saved options and runtime option/hold fields in TeamOverview; (4) `managementSpecs.ts`, preload and `ManagementApi` lack ordered edits and switch/resume methods; (5) MemberForm and TeamsScreen have only single-agent editing and no live option controls.

### Shared shapes and compatibility

A resolved saved option is `ResolvedAgentOption = {id: string, name: string | null, provider: string | null, model: string | null, reasoning: string | null, description: string | null, state: "ok" | "missing"}`. Members expose `agentMode: "ordered_catalog" | "single_catalog" | "inline"`, `agentOptions: ResolvedAgentOption[]`, and `defaultAgent: string | null`. Runtime adds `configuredAgents: string[] | null`, `activeAgent`, `quotaHolds: Record<string, string | null>`, `pendingAgent`, actual provider/model/reasoning, assignment evidence, `stale`, and `lastSwitch: null | {state: "pending" | "completed" | "failed", requestedAgent: string, assignmentId: string | null, code: string | null, message: string | null, at: string}`. Known holds are ISO-8601 reset strings; null means "Reset time unknown". The latest durable switch event is the result source; local optimistic state may say only "Requesting…" before projection.

Saved order is authoritative, with index zero the default for a future start without a valid persisted selection. Live operations use `configuredAgents` frozen at start; `appliesOnNextStart` edits do not change current eligibility. On restart retain a persisted selection if still configured; otherwise choose the first non-held saved option, or the first option with `limit_reached` if all are held. The coordinator recovers expired known holds. Resume clears only the specified hold without verifying quota; inactive resume neither switches nor interrupts, and active resume may restore availability.

Missing saved references remain visible for repair and block a new save; never silently remove them. Preserve member name, role, identity and `canAddTickets`. Inline members remain editable without conversion and have no switch/resume controls until explicitly converted; single-catalog members remain supported without an alternate target. Provider readiness is checked at switch time; show `PROVIDER_UNAVAILABLE` and its reason/remediation. Backend validation and coordinator-only runtime writes remain authoritative; no arbitrary serve command, SQLite access from Electron, or new agent write permission is permitted.

### Epics → stories

| Epic | Story | Board ticket | Dependencies | Outcome |
|---|---|---|---|---|
| Runtime | [P05-S18](./stories/P05-S18-frozen-member-agent-runtime.md) | T-050 | T-039 | Freeze options and project switch result |
| Read model | [P05-S19](./stories/P05-S19-multi-agent-management-read-model.md) | T-051 | T-040, T-050 (S18) | Saved options and runtime projection |
| Desktop boundary | [P05-S20](./stories/P05-S20-multi-agent-management-ipc.md) | T-052 | T-042, T-051 (S19) | Typed named IPC |
| Saved editing | [P05-S21](./stories/P05-S21-ordered-member-options-ui.md) | T-053 | T-044, T-052 (S20) | Ordered options editor |
| Live controls | [P05-S22](./stories/P05-S22-live-agent-switch-controls.md) | T-054 | T-045, T-052 (S20), T-053 (S21) | Switch and resume controls |
| Acceptance | [P05-S23](./stories/P05-S23-multi-agent-live-gate.md) | T-055 | T-047, T-053 (S21), T-054 (S22) | Accessible Windows plus WSL live gate |

T-047 is not yet merged and supplies only its completed accessibility/responsive baseline audit and Windows Electron plus WSL Teams live-gate evidence, not a callable data interface. Feature implementation does not wait for it. Child tickets remain in backlog until the configured plan-merge workflow promotes them after this planning change merges; the operator reviews boundaries and priority then. Windows/WSL execution is deferred to S23.

## Standalone Agents catalog management — T-056

Move reusable agent catalog management out of Teams into a dedicated workspace Agents screen, while Teams continues to assemble members from that shared catalog and remains the only place for live activation, quota, and switching controls. Operators can search, filter, inspect, create, edit, duplicate, and safely delete saved agent definitions without mistaking saved changes for the currently running agent.

### Open questions and planning assumptions

| Question | Assumption used by these stories |
|---|---|
| Does the backend provide friendly provider names or a model registry? | No. Show the provider ids returned by the backend contract, expose only configured model values as suggestions, and keep model entry free-form only when the selected provider reports `modelSelectable`; do not reproduce illustrative mockup brands or models. |
| How complete can “Used by” be? | Reuse `team.overview` and count every saved `agentOptions` reference, not only the default option. Show member/team names when present, “at least” for truncated projections, and “Usage unavailable” for an unavailable overview; backend `AGENT_IN_USE` remains deletion authority. |
| Can the UI repair an invalid hand-edited `agents.json`? | No. `agentdef.list` may display parsed entries plus problems, but existing mutation commands reject an invalid catalog. Keep entries inspectable, disable mutations with an actionable explanation, and never overwrite invalid configuration. |
| Should Agents have URL routing or open directly to a specific entry? | No new router is introduced. Add `agents` to the existing `WorkspaceShell` section state, select the first visible entry by default, and preserve current workspace-switch reset behavior. |
| What happens to a running member after a catalog edit? | Nothing immediately. Every mutation success and editor note says saved changes apply on a future team start; live selection, quota holds, cancellation, resume, and switching stay in Teams. |

### Verified architecture and contract gaps

- `backend/agent_studio/agentcatalog.py` already stores `id`, `name`, `provider`, optional `model`, `reasoning`, and `description`; derives or validates slug ids; makes ids immutable; validates provider-specific settings; writes atomically; preserves unrelated fields; and rejects referenced deletion with `AGENT_IN_USE` plus team ids.
- `agentdef.list/create/update/delete` are already allowlisted through `app/src/main/managementSpecs.ts`, `app/src/preload/preload.ts`, and `ManagementApi` in `app/src/shared/management.ts`. No arbitrary command, credential, activation, or runtime mutation is needed.
- The missing editor contract is provider capability metadata. Extend the existing `agentdef.list` result with production provider ids, `modelSelectable`, allowed `reasoningLevels`, and model values observed in valid configured entries; do not probe authentication or invent a model registry.
- `TeamsScreen.tsx` currently loads catalog data both for member forms and for a visible read-only `AgentCatalogPanel`. Remove only that visible panel: Teams must retain `management.agents()` for ordered member option selection and must retain all live controls.
- `team.overview` already distinguishes saved `agentOptions` from runtime `activeAgent` and reports truncation/partial state. The Agents screen may use it for references, but must never infer live activation from the catalog or claim that editing switches a member.
- Reuse `WorkspaceShell.tsx`, `navModel.ts`, `ShellIcon.tsx`, the existing dark tokens in `styles.css`, `useDashboardSection`, and structured `ManagementResult` feedback. The reference [agents-screen-v1.png](../../design/agents-screen-v1.png) supplies hierarchy and visual direction only.

### Epics → stories

| Epic | Story | Outcome |
|---|---|---|
| Editor contract | [P05-S24](./stories/P05-S24-agent-editor-options-contract.md) | Backend-derived provider, reasoning, and configured-model choices on the existing catalog read |
| Standalone catalog | [P05-S25](./stories/P05-S25-agents-navigation-and-browser.md) | Agents navigation, searchable/filterable catalog, details, and truthful saved references; no catalog panel in Teams |
| Catalog mutations | [P05-S26](./stories/P05-S26-agent-create-edit-duplicate.md) | Validated create, edit, and duplicate flows with immutable ids and saved-versus-live messaging |
| | [P05-S27](./stories/P05-S27-agent-delete-guards.md) | Explicit unused-agent confirmation and clear referenced-delete protection |
| Completion | [P05-S28](./stories/P05-S28-agents-states-responsive-accessibility.md) | Automated loading/empty/disconnected/error/narrow-layout and accessibility coverage |

These stories intentionally add no live acceptance gate. The operator owns manual application verification; implementation tickets require only focused backend, renderer, IPC, accessibility, typecheck, and build automation.

## Roles catalog and shared role instructions — T-062

**Goal.** Add a dedicated workspace Roles destination where operators can browse, search, create, edit, and safely delete reusable roles, including their descriptions, instruction files, and configured skills. A role can be assigned to many team members; its shared instructions are resolved for each new assignment while member permissions, ordered agent options, live switching, and quota controls remain independent.

**Goal, restated.** Make the existing `.agent-studio/roles.json`, role Markdown, skill, team, workflow, and board-routing semantics visible and safely editable without inventing a second role store. Connect Teams to that catalog with a constrained role selector and a link to the selected role, while preserving frozen dispatch evidence and existing team/agent behavior.

### Open questions and planning assumptions

| Question | Assumption used by these stories |
|---|---|
| Is a role's identifier renameable? | No. The `roles.json` object key is the stable role id used by teams, workflow stages, board rules, running agents, and direct tasks. Add an optional mutable `name` for the user-facing label; “rename” edits that label and therefore cannot break references. Existing roles without `name` display their id. |
| Must display names be unique? | New and updated explicit names must be non-empty and case-insensitively unique after trimming. Legacy duplicate/missing names remain inspectable by stable id and are reported as catalog problems; an affected role can still be edited to repair its name. |
| How are existing instruction files handled? | Preserve each valid existing `instructions` relative path and edit that file in place with confinement, UTF-8, and size checks. A newly created role receives `.agent-studio/roles/<id>.md`; a role with no path gets that conventional path only when instructions are first saved. Never rewrite custom paths merely by reading or editing other fields. |
| When does an instruction edit take effect? | It affects assignments created after the successful save. Existing assignments and workflow attempts keep their frozen `roleContext`, hashes, and sources; a running team need not restart. Team member role changes continue to apply on the next team start under the existing contract. |
| Which references block deletion? | Any saved team definition, legacy `.agent-studio/team.json` member, board rule, loadable workspace workflow stage, or live runtime agent using the stable id blocks deletion and returns structured references. Invalid/unreadable reference sources make deletion fail closed. Historical stopped runtimes and already-frozen completed/current assignments do not require rewriting. |
| Are role skills managed here? | Yes. The Roles detail shows configured skill ids, whether each `.agent-studio/skills/<id>/SKILL.md` exists, and warnings from normal role resolution. Editing changes only the ordered role `skills` list; it never creates, edits, or deletes skill files. Missing skills stay visible for repair. |
| What happens to the existing role editor in routing settings? | Remove the duplicate description editor from `RoutingSettingsPanel`, but retain its role choices and routing validation. All role metadata, instructions, skills, and deletion live in Roles. |
| Does a role inherit permissions or agents? | No. `canAddTickets`, ordered agent options, active-agent switching, and quota controls remain member/runtime settings in Teams. The member sketch's inheritance wording is corrected in the implementation copy and tests. |

### Verified architecture and contract gaps

- `backend/agent_studio/roles.py` already validates `.agent-studio/roles.json`, confines instruction and skill paths, bounds content, resolves legacy `.agent-studio/roles/<role>.md`, and builds a hashed role context. `tasks.build_request` freezes that context when an assignment is created; `teams.start_team` reads it only for start feedback.
- `teamdefs.py` validates member role ids; `boardmodel.check_rules` validates board-rule roles and workflow compatibility; `workflowdef.list_definitions` exposes workspace workflow roles. There is no combined role usage index or safe delete command, and live runtime agents must also be checked through the read-only state connection.
- `boardsettings.py` exposes only role id/description and can update only a description in `roles.json`. It has optimistic SHA checking for that file but no instruction-file token, role create/delete, display name, skill projection, reference details, or partial instruction warnings.
- `team.overview` already exposes each member's stable role and role state, and Teams already edits role text fields. The member editor needs catalog choices, undefined-reference preservation, and a Roles deep link without changing member agent, permission, switching, or quota contracts.
- `WorkspaceShell.tsx` routes Home, Teams, and Agents in local section state. Add Roles beside Teams/Agents and extend the navigation callback with an optional selected role id; do not introduce URL routing or arbitrary renderer commands.
- The design references provide hierarchy and dark-theme direction only. All names, counts, status, skills, assignments, and warnings come from workspace configuration/runtime responses.

### Epics → stories

| Epic | Story | Outcome |
|---|---|---|
| Catalog reads | [P05-S29](./stories/P05-S29-role-catalog-read-model.md) | Full role, instruction, skill, warning, and catalog-problem projection |
| Reference safety | [P05-S30](./stories/P05-S30-role-reference-index.md) | Saved and live usage index with fail-closed partial states |
| Backend mutations | [P05-S31](./stories/P05-S31-role-metadata-and-skills-mutations.md) | Stable-id create and metadata/skill editing with safe display-name rename |
| | [P05-S32](./stories/P05-S32-role-instructions-mutation-and-dispatch.md) | Concurrency-safe instruction-file editing and frozen-dispatch proof |
| | [P05-S33](./stories/P05-S33-role-delete-guards.md) | Referenced-role protection and safe unused-role cleanup |
| Desktop boundary | [P05-S34](./stories/P05-S34-role-management-ipc.md) | Typed, named, allowlisted Roles IPC |
| Roles UI | [P05-S35](./stories/P05-S35-roles-navigation-and-browser.md) | Roles navigation, search, selection, details, assignments, and states |
| | [P05-S36](./stories/P05-S36-role-create-and-edit-ui.md) | Accessible create/edit flows for metadata, instructions, and skills |
| | [P05-S37](./stories/P05-S37-role-delete-ui.md) | Explicit deletion confirmation and in-use safeguards |
| Teams integration | [P05-S38](./stories/P05-S38-team-member-role-integration.md) | Existing-role selection and deep link with member settings kept separate |

These stories add no live acceptance gate or manual evidence requirement. Focused backend, integration, renderer, IPC, typecheck, and build automation are the implementation acceptance evidence.
