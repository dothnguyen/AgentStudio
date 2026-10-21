# P00-S03 — N worker panes in one native tmux window

Status: To Do
Depends on: P00-S01, P00-S02
Architecture: [P00 implementation contract](../architecture.md), sections A, D, E

## Goal

Launch a configured team of N provider-neutral worker shims in exactly N panes of one tmux window. Assignments reach workers through coordinator-written request files, never keystrokes. The operator watches by attaching a normal terminal (WSL shell or Windows Terminal). No pane-output API or UI terminal component.

## Implement in this order

1. `backend/bin/agent-studio-worker` (Bash). Accepts only validated runId and agentId, changes to the canonical workspace, prints provider/role and an idle banner, waits for a request file in its agent's private inbox directory, runs `agent-studio runner <assignmentId>` in the foreground, removes/archives the request file, and returns to idle. It makes no state decisions. Until S04 the runner executes a stub that writes a fake report.
2. `team.start` input: ordered roster of `{agentId, providerId, role}`. Reject zero members, duplicate IDs, unsupported provider IDs, and rosters above the explicit P00 limit; never drop a member silently.
3. Generate an unguessable run ID and one run-scoped session. Create the first pane, split once per additional member, select `tiled`. Verify `list-panes` count equals roster size **before** reporting success. Test N=2 and N=3.
4. Record session/window/pane IDs, pane PID + start time, agent, provider, canonical workspace, and ownership marker (tmux user option). Later checks use pane IDs and the marker, never pane indices.
5. Coordinator claim path: mark an assignment `claimed` in a transaction, then write the `0600` request file into that agent's inbox. The runner reports start evidence; only then does the coordinator commit `running`.
6. `team.attach`: verify the owned session and run native `tmux attach-session`, or—without a TTY—return exact WSL and Windows Terminal (`wsl.exe -d <distro> --exec tmux attach-session -t <id>`) commands. Document detach (Ctrl-b d), pane selection, zoom (Ctrl-b z), and reattach. Attach never creates a session.
7. Pane liveness is tracked separately from assignment state. Detach leaves workers running. A verified dead pane makes its agent `offline`; it never makes a task succeeded.
8. Scoped `team.stop` with ownership validation and bounded shutdown. Ambiguous identity → `CLEANUP_INCOMPLETE`, session preserved. Never `kill-server`.

## Tests to write

- N=2 and N=3 yield exactly two and three panes in one window, no operator pane.
- An unrelated pre-existing tmux session is unchanged across start, attach, detach, and stop.
- Pane IDs stay mapped to the correct agents after resize, focus change, and reattach.
- Each worker runs only its own request file; a request file for another agent is ignored and reported.
- Dead pane, missing session, mismatched marker, and reused pane index produce typed diagnostics and no broad deletion.
- Manual: attach from WSL and from Windows Terminal, see each label and live output, detach, confirm progress continues, reattach.

## Done when

- [ ] Configured N equals observed pane count for N=2 and N=3.
- [ ] One terminal window shows all panes in tiled layout, from WSL and Windows Terminal.
- [ ] Native detach/reattach works without an output bridge or re-dispatch.
- [ ] Task delivery comes from coordinator claims and request files, never tmux keystrokes.
- [ ] Stop affects only verified run-owned sessions; evidence includes before/after tmux inventory.

Do not infer task outcome from pane output.
