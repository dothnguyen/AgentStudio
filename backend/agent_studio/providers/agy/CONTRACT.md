# agy adapter contract

The operator has approved `agy` for `workspace_write` assignments with a weaker
isolation guarantee. **Workspace-only isolation is not guaranteed**: agy reads
global settings, which may permit external writes, and its terminal sandbox can
silently be unavailable. Agent Studio passes `--sandbox` as a best effort, not a
guarantee. `read_only` is unsupported and rejected by generic policy validation
before any provider process starts. Do not use agy for read-only roles.

The adapter uses `--mode accept-edits`, streaming JSON over stdin/stdout, and
optional model/effort flags. It does not enable permission bypass. Existing agy
permission settings still apply and can cause headless operations to be denied.
Permission denial diagnostics are treated as waiting for input, including when
the CLI exits successfully. Assignment-specific Agent Studio board MCP is not
supported and requests to enable it are rejected. Global agy MCP configuration is
managed by agy, not isolated by this adapter.

Discovery verifies version and required help flags; authentication is not proven
by a shallow probe. The installed agy 1.4.8 was manually checked on WSL and a
no-tools streaming prompt returned the expected response. A disposable live workspace-write run created a marker file successfully. Live
workflow and cancellation checks are not yet verified. The generic runner handles
process-group cancellation and reconciliation. Fixtures in tests are hand-authored.

References: https://antigravity.google/docs/cli/headless/ and
https://antigravity.google/docs/sandbox-mode/.
