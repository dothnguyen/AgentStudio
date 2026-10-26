# P04-S15 — Backend: read-only `team.list` for a workspace

Status: To Do
Depends on: none
Architecture: [P04 design contract](../README.md#design-contract), §A (workspace registry), §C (team definitions), §D (board); renderer rules: ticket T-014 (allowlisted preload only, one `serve` process)

## Goal
The dashboard cannot list a workspace's team definitions today: `team.status` needs a known definition id and `teamdefs.list_teams` is CLI-only. Add one read-only dispatch command `team.list` returning every definition with a bounded runtime summary, composed from `teamdefs` and `teamstatus.team_status`, so the renderer needs no per-team calls.

## Implement in this order
1. Discovery (record): `backend/agent_studio/dispatch.py` `COMMANDS` has `team.start/stop/attach/status` but no list; `teamdefs.list_ids/load/list_teams` read `.agent-studio/teams/<id>.json`; `teamstatus.team_status(conn, team_id, workspace, def_id)` returns `{team:{id,teamDefId,name,status,workspace}|null, members:[{memberId,name,role,provider,agentId,availability,paneState,assignment:{id,status,taskId}|null}]}`; agents `availability` vocabulary lives in `schema.py` (record the exact values, including `limit_reached`).
2. Add `teamstatus.workspace_teams(conn, workspace)` returning `{workspace, teams:[{id, name, members: <definition member count>, problems?: [{path,message}], runtime: null | {teamId, status, memberCount, availability: {<value>: n}, activeAssignments: n}}]}`. A definition that fails to load yields an entry with `problems` and `runtime: null`, not a failed command. Cap at 50 definitions with `truncated: true`. Return only counts, no prompts, paths or provider output.
3. Register `"team.list": _team_list` in `dispatch.py` using `_workspace_arg`, `_reader()`, closing the connection; reject unknown args like the neighbouring read commands. Do not touch board code (`teamstatus.py` imports none).
4. Document the shape in `backend/README.md` command table only if that table lists read commands.

## Done when
- [ ] No definitions → `teams: []`; one stopped and one running definition report the right `runtime`; availability counts match the agents rows. Test: new `tests/unit/test_p04_s15_team_list.py`.
- [ ] A malformed definition file is reported in `problems` while others still list. Test: same file.
- [ ] A missing/relative workspace argument gives the standard BAD_REQUEST envelope; the command writes nothing (event head and inbox unchanged). Test: same file.
- [ ] Validation: python3 -m pytest <the new unit test file> tests/unit -q; python3 scripts/validate.py --touched.

Out of scope: any renderer/IPC change (S18), team lifecycle, legacy `team.json` import beyond what `teamdefs.list_ids` already does.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
