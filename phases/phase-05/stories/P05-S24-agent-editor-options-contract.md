# P05-S24 — Expose backend-derived agent editor options

Status: To Do
Depends on: P05-S08 (T-038), P05-S12 (T-042)
Architecture: [Standalone Agents catalog management](../README.md#standalone-agents-catalog-management--t-056)

## Goal
Extend the existing catalog list contract with the production provider capabilities and configured model suggestions needed by a safe editor, without adding provider probes, credentials, runtime controls, or a broad desktop command.

## Implement in this order
1. In `backend/agent_studio/agentcatalog.py`, add an `editorOptions` object to `list_agents(workspace)`. Its `providers` array follows `providers.PEERS` order and each item is exactly `{id, modelSelectable, reasoningLevels, configuredModels}`; obtain `modelSelectable` and `reasoningLevels` from each registered adapter, and collect unique non-empty model strings from catalog entries with that provider in stable catalog order.
2. Exclude `providers.TEST_ONLY` even when a hand-edited catalog mentions one. Do not call `probe`, read credentials, report availability/authentication, or claim an exhaustive model list; `configuredModels` is only saved workspace data.
3. Keep the existing `version`, `agents`, and `problems` behavior. A missing file returns all production provider descriptors and no configured models; structurally invalid entries may still contribute no suggestion, while the existing problems remain authoritative and every mutation continues to reject an invalid catalog.
4. In `app/src/shared/management.ts`, type `AgentEditorProviderOption` and the new `AgentCatalogList.editorOptions`. Update `app/test/teamsFixtures.ts` and other catalog fixtures without adding a new preload method or IPC channel.
5. Extend `tests/unit/test_p05_s08_agent_catalog.py`, `app/test/managementIpc.test.ts`, and `app/test/preload.test.ts` only where needed to prove the existing `management.agents` path forwards the new response unchanged.

## Done when
- [ ] `agentdef.list` returns only production provider ids, adapter-derived `modelSelectable`/`reasoningLevels`, and stable de-duplicated configured model suggestions; tests cover missing, valid, duplicate-model, test-only, and invalid-entry catalogs.
- [ ] No provider probe or credential lookup occurs while listing editor options. Test: patch every adapter `probe` to fail and assert `tests.unit.test_p05_s08_agent_catalog` still passes.
- [ ] The typed `ManagementApi.agents()` result contains the exact new shape without a new arbitrary IPC capability. Test: `npm --prefix app test -- managementIpc preload` and `npm --prefix app run typecheck`.
- [ ] Existing create/update/delete validation and response fields are unchanged. Test: `python3 -m unittest tests.unit.test_p05_s08_agent_catalog tests.unit.test_p05_s09_team_edit`.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
