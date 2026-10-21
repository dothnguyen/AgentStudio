# P00-S11 — OpenCode provider adapter

Status: To Do
Depends on: P00-S04 (contract), P00-S05 (real direct-task check)
Architecture: [P00 implementation contract](../architecture.md), section F

Follow the **shared adapter checklist** in the [stories README](./README.md). This story lists only what is specific to OpenCode. It may be marked Blocked with a recorded capability gap; any two Done adapters unblock S12.

## OpenCode-specific steps

1. Inspect installed `opencode` version/help via the entry shim; compare with the [OpenCode CLI documentation](https://opencode.ai/v2/docs/cli/commands/). Record exact flags and event shapes in `providers/opencode/CONTRACT.md`. Candidate: `opencode run` with JSON output.
2. Preflight distinguishes missing CLI, missing configured model/provider, and missing credentials.
3. Policy mapping: supply a run-scoped permission configuration for `read_only` and `workspace_write`; never rely on a permissive user default without showing and accepting it.
4. If there is no authoritative terminal event, document and test the equivalent (final response + exit + validation). Never infer completion from tmux idle.
5. Use server-backed mode only if required; record any server/session identity, and never stop a shared OpenCode server Agent Studio did not create.

## OpenCode-specific fixtures

Success, provider/model error, permission rejection, malformed event, missing final response, nonzero exit; ownership test for unrelated sessions/servers.

## Done when

- [ ] Shared checklist complete for providerId `opencode`.
- [ ] Cleanup never touches a non-owned OpenCode server or session.
