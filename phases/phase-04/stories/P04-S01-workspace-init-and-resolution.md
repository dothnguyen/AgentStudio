# P04-S01 — Workspace init and resolution

Status: To Do
Depends on: —
Architecture: [P04 design contract](../README.md#design-contract), §A, §B

## Goal
`agent-studio init` creates and registers a workspace, and every command finds its workspace by walking up from the current directory, with `--workspace` as an override. A shared output helper gives every new command human text on a terminal and JSON with `--json`, while `request` and `serve` stay JSON.

## Implement in this order
1. Workspace resolver in `backend/agent_studio` (new module): walk up from cwd to the first `.agent-studio/workspace.json`; `--workspace PATH` wins; no match returns `WORKSPACE_NOT_FOUND` with the remediation `run agent-studio init`.
2. `init [--name N] [--path P]`: create `.agent-studio/`, write `workspace.json` `{id, name}` (id stable, name defaults to the folder name), register the canonical path in the registry (state dir). Running it again in an initialised folder is a no-op that prints the existing workspace.
3. Registry: `workspace list` reads it; a path that no longer exists is shown as missing, never deleted silently.
4. Output helper: `emit(result, human_renderer, json_flag)`; error rendering as `CODE: message` plus remediation. Wire only `init` and `workspace list` now; later stories reuse it.
5. Existing commands keep accepting `--workspace` unchanged; those that do not require a workspace today stay as they are.

## Done when
- [ ] `init` in an empty folder writes `workspace.json` and registers it; a second `init` changes nothing. Test: unit.
- [ ] Resolution works from a subfolder, `--workspace` overrides it, and an unregistered folder gives `WORKSPACE_NOT_FOUND`. Test: unit.
- [ ] `--json` output parses as JSON; terminal output is human text; `request` and `serve` output is unchanged. Test: unit + one integration test through the real CLI entry.
- [ ] Existing `team start --workspace`, `task direct` and `workflow start` still work. Test: existing suites stay green (`python3 scripts/validate.py --unit`).

## Evidence
(filled in when the story is done)
