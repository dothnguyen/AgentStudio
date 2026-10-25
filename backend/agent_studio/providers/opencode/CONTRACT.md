# opencode adapter contract note

Status: **implemented, Blocked for runs** (P00-S11). The adapter is real: `probe` resolves the executable,
verifies the version and the flags it uses, checks `auth list`, and then reports `CAPABILITY_GAP` because
no run can be permission-scoped (below). Every policy is `unsupported`, so preflight and `team.start` refuse
this provider instead of running it with unverified permissions — and instead of substituting another.

Verified against the **installed CLI, opencode v2.1.4** (ELF binary at `~/.opencode/bin/opencode`, installed by
`opencode-ai@1.2.27` / the install script; *not* on the login PATH by default — the adapter falls back to that
path). Every item below was run against the real binary on 2026-10-25; nothing is guessed.

| Item | Value |
|---|---|
| Tested version | `opencode v2.1.4` (`opencode --version`) |
| Executable resolution | login `PATH` first, then the installer default `~/.opencode/bin/opencode` |
| `run` flags used | `run --standalone --format json --log-level none [--model provider/model#variant]` (all verified in `opencode run --help`) |
| Prompt channel | stdin (private prompt file); `run`'s message argument is never used, so no user text reaches a command line. Stdin-without-argument behaviour is documented, not yet captured (no runnable model) |
| Authentication probe | `opencode auth list` → one `… stored` line per credential (verified with a stored "OpenCode Go" credential). The disposable read-only micro-task is **not possible**: every run fails upstream before any model output |
| `read_only` flags | unsupported (see gap) |
| `workspace_write` flags | unsupported (see gap) |
| Output format | `run --format json`: newline-delimited JSON events on stdout |
| Terminal event | the `error` event is the only failure signal — **the CLI exits 0 on a provider error** (verified: `provider.auth` 403 and `provider.invalid-request` 400 both exit 0). Success ends with a `step-finish` part (documented, not captured) |
| Session identity | `sessionID` on every event, `ses_…` (verified); sessions are never resumed by Agent Studio (`resume: unsupported`) |
| Cancel / reconcile | by recorded PID + start time like the other adapters; the run's `--standalone` server is a child of the provider process group and dies with it. Agent Studio never touches the shared background `opencode service` |

## Captured events (real, v2.1.4)

```json
{"type":"step_start","timestamp":1792931707301,"sessionID":"ses_e8cf14a9dffeTRmV1jJOdugG4B",
 "part":{"id":"prt_…","sessionID":"ses_…","messageID":"msg_…","type":"step-start","snapshot":"…"}}
{"type":"error","timestamp":1792931707318,"sessionID":"ses_…",
 "error":{"type":"provider.auth","message":"Upstream request failed: An active OpenCode Go subscription is required…",
          "status":403,"response":{"body":"…"}}}
```

`provider.auth` → `AUTH_REQUIRED`; every other `error.type` → `PROVIDER_ERROR`. Text/tool/step-finish part shapes
(`part.type` `text` with `text`, `tool` with `state`, `step-finish` with `tokens`) follow opencode's part model and
are parsed, but **not captured from a successful run** — the adapter treats a stream with no terminal event as
`inconclusive`, never `succeeded`.

## The gap (why both policies are refused)

`opencode run --help` (v2.1.4) has **no `--config` flag**, and the config loader ignores per-process overrides —
verified empirically:

- `OPENCODE_CONFIG=/path/to/bad.json opencode run …` → silently ignored (a broken config file changed nothing).
- `XDG_CONFIG_HOME=/tmp/… opencode run --standalone …` with a valid config setting `model` → no effect on the
  request (the default Go model was still requested). `debug paths` honours `XDG_CONFIG_HOME` but the config
  sources (`debug config`) stay at `~/.config/opencode`.
- A project-root `opencode.json` is read only from the workspace — which a `workspace_write` agent can edit, so it
  cannot carry the permission rules that constrain it, and writing it would dirty the workspace the workflow
  committed as its base.

The only remaining location is the global `~/.config/opencode/opencode.json`, which is shared with the user's
interactive opencode; a permissive default there is exactly what the story forbids without showing and accepting
it. The stored credential is also unusable for verification runs: every model the credential can list fails
upstream with `provider.auth` 403 "An active OpenCode Go subscription is required" (or the workspace-privacy 400),
so success, tool-use and permission events cannot be captured in this environment.

## Policy design (what unblocks this adapter)

Once a verified injection mechanism exists (a future `--config` flag, an honoured `OPENCODE_CONFIG`, or an
operator-accepted global permissions file), implement `POLICY_FLAGS` in `adapter.py` from the v2 rules model
(`permissions: [{action, resource, effect}]`; actions include `edit` and `shell`) and delete the `CAPABILITY_GAP`
branch in `probe`:

- `read_only`: deny `edit` (`{"action": "edit", "resource": "*", "effect": "deny"}`) and deny `shell` except the
  read-only allowlist, mirroring the claude adapter's split; add `guard_read_only = True` if the sandbox still
  allows writes.
- `workspace_write`: allow `edit` inside the workspace, deny `shell` commands that leave it; `--auto` stays
  forbidden (it is the bypass analog and is in `NEVER`).

Then capture success / permission-blocked / malformed / missing-final / nonzero-exit fixtures from the real CLI
(`tests/fixtures/opencode/`) and re-verify this table against the new version.
