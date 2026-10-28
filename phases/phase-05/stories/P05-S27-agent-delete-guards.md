# P05-S27 — Guard agent deletion with saved references

Status: To Do
Depends on: P05-S25, P05-S26
Architecture: [Standalone Agents catalog management](../README.md#standalone-agents-catalog-management--t-056)

## Goal
Delete only an explicitly confirmed unused saved agent, while explaining known team-member references and preserving backend `AGENT_IN_USE` validation as the final authority under incomplete or changing data.

## Implement in this order
1. Use the saved-reference projection from `agentsModel.ts` in `AgentsScreen.tsx` to list referenced team/member names in the details pane. When references are known, disable Delete and associate an explanation with the control; link or instruct the operator to use Teams without editing membership automatically.
2. For an agent known to be unused, open an accessible confirmation dialog naming the agent and immutable id. Cancel performs no API call and restores focus; confirm calls exactly `management.deleteAgent(workspace.id, agent.id)` once and disables repeated confirmation while pending.
3. When usage is unavailable or truncated but no reference is visible, label that uncertainty and still require confirmation; do not claim the agent is unused. The backend remains authoritative and may reject the request.
4. On success reload catalog and overview, select the next visible entry (previous entry if the deleted item was last), and announce deletion. Do not call team/member writes, alter runtime state, or imply a live switch.
5. On `AGENT_IN_USE`, keep the agent selected, close or return focus from the dialog predictably, render backend team ids from `error.data.teams` plus remediation, and refresh overview so a racing reference becomes visible. Preserve all other structured error messages and the catalog entry.
6. Add deletion and focus cases to `app/test/agentsScreen.test.tsx`, with exact API-call assertions and a regression assertion that no `updateMember`/`removeMember` method is called.

## Done when
- [ ] Known referenced agents cannot open a delete confirmation and show every available saved team/member reference, including non-default ordered options. Test: `app/test/agentsScreen.test.tsx`.
- [ ] A known-unused agent is deleted only after explicit confirmation; cancel, Escape, repeated clicks, and pending state make zero or one calls as appropriate and restore focus. Test: dialog interaction cases.
- [ ] Unavailable/truncated usage is never labelled “unused”; a backend `AGENT_IN_USE` race leaves the catalog and team membership unchanged and reports team ids/remediation. Test: rejected response followed by overview refresh.
- [ ] Successful selection fallback works for first, middle, last, filtered, and sole entries, and its message says only the saved definition was deleted. Test: parameterized component cases.
- [ ] `npm --prefix app test -- agentsScreen teamsScreen`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
