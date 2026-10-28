# P05-S26 — Create, edit, and duplicate saved agents

Status: To Do
Depends on: P05-S24, P05-S25
Architecture: [Standalone Agents catalog management](../README.md#standalone-agents-catalog-management--t-056)

## Goal
Add focused create, inspect/edit, and duplicate workflows for every supported catalog field while preserving immutable ids, backend provider validation, and a truthful boundary between saved definitions and live runtime.

## Implement in this order
1. Add `app/src/renderer/agents/agentFormModel.ts` with form values for `id`, `name`, `provider`, `model`, `reasoning`, and `description`; normalization/diff helpers for `AgentDefInput` and `AgentDefChanges`; slug validation matching the backend; 80/4000 character limits; and deterministic duplicate defaults (`<name> copy`, first available `<id>-copy[-N]`). Never change an existing id.
2. Add `app/src/renderer/agents/AgentForm.tsx` and connect it in `AgentsScreen.tsx`. Create/duplicate show an editable required id; edit shows the id as read-only and sends only mutable changed fields. Cancel discards the draft and returns focus to the invoking control; prevent duplicate submission while a request is pending.
3. Populate provider choices from `AgentCatalogList.editorOptions.providers`. Offer only that provider’s `reasoningLevels` plus an explicit unset value; disable reasoning when none are supported. Permit model input only when `modelSelectable`, provide that provider’s `configuredModels` as suggestions rather than an exhaustive claim, and clear or require correction of settings made invalid by a provider change.
4. Call only existing `management.createAgent` and `management.updateAgent`. On success reload the catalog, select the returned id, render a dismissible status message, and state that saved changes apply on a future team start while live agent switching stays in Teams. On structured failure keep the draft, associate backend `data.problems` with matching fields where possible, and show code/message/remediation without claiming a save.
5. Disable all mutation entry points when catalog problems are present and explain that invalid `agents.json` must be repaired before safe writes. Missing/unknown provider metadata also blocks submit without inventing choices; the existing selected entry remains inspectable.
6. Add `app/test/agentFormModel.test.ts` and create/edit/duplicate cases to `app/test/agentsScreen.test.tsx`; extend `app/test/managementIpc.test.ts` only if a regression in the existing exact request shapes is found.

## Done when
- [ ] Create submits all six supported fields with an explicit valid id, selects the returned entry, and duplicate copies mutable settings under a collision-free new id without writing until submit. Test: `app/test/agentFormModel.test.ts` and `app/test/agentsScreen.test.tsx`.
- [ ] Edit renders id read-only, never includes id in `AgentDefChanges`, sends only changed mutable fields, and supports clearing optional description/model/reasoning with `null`. Test: component assertions on exact `ManagementApi` calls.
- [ ] Provider, reasoning, and model controls use only backend/configured choices; unsupported combinations, blank required values, duplicate ids, over-limit text, invalid slugs, missing metadata, and invalid catalogs cannot submit. Test: model and component table cases.
- [ ] Backend errors preserve form input and are announced; successful messages explicitly distinguish saved configuration from live runtime. Test: rejected `AGENT_EXISTS`, `AGENT_CATALOG_INVALID`, `SETTING_UNSUPPORTED`, thrown-call, and success responses.
- [ ] `npm --prefix app test -- agentFormModel agentsScreen managementIpc`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
