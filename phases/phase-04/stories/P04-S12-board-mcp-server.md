# P04-S12 — Board MCP server

Status: To Do
Depends on: P04-S08 (phases), P04-S10 (scheduler and run-board)
Architecture: [P04 design contract](../README.md#g-board-mcp-server-s12)

## Goal
An agent working an assignment can add tickets (for example the findings of a review) to the board, and list tickets and phases, through an MCP server. Agents never touch the database or files; the coordinator stays the only writer.

## Implement in this order
1. **Spike first (Q10).** With the real Claude Code and Codex CLIs, run a minimal stdio MCP server from a generated per-assignment config inside the sandbox the adapters use today. Record in the story Evidence whether the server starts and whether it can reach the coordinator's command inbox. A provider that cannot is out of scope; say so in the README and stop for that provider.
2. `agent-studio mcp`: stdio JSON-RPC 2.0 server, standard library only. Methods `initialize`, `tools/list`, `tools/call`; errors map to JSON-RPC errors with the command error code in `data`.
3. Tools: `ticket_add` (title, body, priority?, phase?, dependsOn?), `ticket_list` (status?, phase?), `ticket_show` (key), `phase_list`, `board_show`. Each call goes through the validated command path (`request` envelope with an idempotency key), never direct DB access.
4. Team definition: optional boolean `canAddTickets` per member in `teams/<id>.json`, with schema validation, `team add-member --can-add-tickets`, and `team show` output. Default false.
5. Adapters: only for an assignment whose member has `canAddTickets`, the Claude adapter generates a per-assignment MCP config (replacing `--strict-mcp-config` for that assignment only) with an allowlist of `mcp__agent-studio__*` tools; the Codex adapter sets the equivalent `mcp_servers.*` overrides. The server environment carries the assignment id and agent id. Other assignments are unchanged.
6. Coordinator rules for `ticket_add`: the assignment must be active and its member allowed (`FORBIDDEN`); the ticket gets `createdBy` (member id, assignment id), the board's `initial` status, and the requested phase (default phase when omitted; unknown or closed phase is refused); per-assignment cap, default 10 (`TICKET_CAP_REACHED`); a duplicate open title is `TICKET_DUPLICATE`. A repeated call with the same idempotency key returns the first result.
7. `fake_cli` scenario that calls the MCP tools, so the path is testable without a real provider.
8. Docs: README section on enabling it for a member and what agents can and cannot do.

## Done when
- [ ] Spike result recorded for Claude Code and Codex, with the commands used. Evidence: live.
- [ ] The server answers `initialize`, `tools/list` and each tool correctly over stdio; errors carry the command code. Test: unit.
- [ ] `ticket_add` creates a ticket with `createdBy`, initial status and the default phase; with `phase` it lands there; cap, duplicate, unknown phase, inactive assignment and a member without `canAddTickets` are refused with nothing written. Test: unit.
- [ ] Retrying `ticket_add` with the same idempotency key creates one ticket. Test: unit.
- [ ] A fake-provider run whose agent adds two tickets leaves them on the board once the run ends; a member without the switch gets no MCP config and its tool calls fail. Test: integration.
- [ ] `canAddTickets` is validated, editable by hand and by `team add-member`; the old definitions without it still load. Test: unit.
- [ ] One live run: a real agent adds a ticket via MCP on a throwaway project. Evidence: live (or the spike's out-of-scope note for the provider).

## Evidence
(filled in when the story is done)
