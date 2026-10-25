"""Claude Code adapter (P00-S09). Verified against Claude Code 2.1.307 (`claude --help`, `claude auth status`, and
real `claude -p --output-format stream-json` output); see CONTRACT.md. Every flag used is checked in the installed
CLI's help at probe time; nothing is guessed."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from typing import Dict, List, Optional

from ...protocol import AsError
from .. import cli_support
from ..base import BASE_ENV, POLICIES, UNSUPPORTED, AssignmentInput, Adapter, ParseState, Prepared, mcp_env

short = cli_support.short

REQUIRED_FLAGS = ("--print", "--output-format", "--verbose", "--permission-mode", "--permission-prompts", "--tools",
                  "--allowedTools", "--strict-mcp-config", "--restricted", "--no-session-persistence", "--model",
                  "--effort")
REQUIRED_MODES = ("dontAsk", "acceptEdits")
NEVER = ("--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions", "auto",
         "Bash", "--add-dir")
REASONING = ("low", "medium", "high", "xhigh", "max")
READ_TOOLS = "Read,Grep,Glob"
MCP_TOOLS = ["mcp__agent-studio__" + n for n in ("ticket_add", "ticket_list", "ticket_show", "phase_list", "board_show")]
COMMON = ["--print", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
          "--strict-mcp-config",             # only MCP servers we pass (none)
          "--permission-prompts", "none",    # nothing can wait on a prompt: anything that would ask is denied
          "--restricted"]                    # no code-running tools, file tools confined to the workspace
POLICY_FLAGS = {
    "read_only": ["--permission-mode", "dontAsk", "--tools", READ_TOOLS, "--allowedTools", READ_TOOLS],
    "workspace_write": ["--permission-mode", "acceptEdits", "--tools", READ_TOOLS + ",Edit,Write,NotebookEdit",
                        "--allowedTools", READ_TOOLS],
}
# Opt-in command access (P01-S09b): `.agent-studio/permissions.json` {"version": 1, "claude": {"commands": true}}.
# Without it nothing changes. With it `--restricted` is dropped (it removes every code-running tool) and Bash is
# added: any command for workspace_write, a short read-only allowlist for read_only.
READ_COMMANDS = ["git status", "git diff", "git log", "git show", "git ls-files", "git rev-parse", "ls", "cat",
                 "python3 -m unittest", "python3 -W ignore -m unittest", "python3 -m pytest",
                 "rg", "ctags -f -"]
COMMAND_FLAGS = {
    "read_only": ["--permission-mode", "dontAsk", "--tools", READ_TOOLS + ",Bash", "--allowedTools",
                  ",".join([READ_TOOLS] + [f"Bash({c}:*)" for c in READ_COMMANDS])],
    "workspace_write": ["--permission-mode", "acceptEdits", "--tools", READ_TOOLS + ",Edit,Write,NotebookEdit,Bash",
                        "--allowedTools", READ_TOOLS + ",Bash"],
}


def commands_enabled(workspace: str) -> bool:
    try:
        with open(os.path.join(workspace, ".agent-studio", "permissions.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        return cfg.get("version") == 1 and (cfg.get("claude") or {}).get("commands") is True
    except (OSError, ValueError, AttributeError):
        return False


ENV = BASE_ENV + ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
                  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
                  "AWS_REGION", "AWS_PROFILE", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION",
                  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
                  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR")
AUTH_RE = re.compile(r"not logged in|/login|invalid api key|authentication_error|oauth token|\b401\b", re.I)
LIMIT_RE = re.compile(r"(?:rate[ -]?limit|usage[ -]?limit|quota)\s*(?:has been |is )?(?:reached|exceeded)|too many requests|\b429\b", re.I)
EPOCH_RE = re.compile(r"\b(1\d{9}(?:\.\d+)?)\b")
CLOCK_RE = re.compile(r"\b(\d{1,2}:\d{2}(?::\d{2})?\s*(?:UTC|GMT|[+-]\d{2}:?\d{2}))\b", re.I)


def limit_reset_at(text):
    """Best-effort normalization of provider-supplied reset hints; never invent a time."""
    epoch = EPOCH_RE.search(text or "")
    if epoch:
        try:
            return datetime.fromtimestamp(float(epoch.group(1)), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except (OverflowError, OSError, ValueError):
            pass
    clock = CLOCK_RE.search(text or "")
    if clock:
        value = clock.group(1).replace("GMT", "UTC").upper().replace("UTC", "+00:00")
        for fmt in ("%H:%M%z", "%H:%M:%S%z"):
            try:
                return datetime.strptime(value.replace(" ", ""), fmt).replace(year=datetime.now(timezone.utc).year,
                    month=datetime.now(timezone.utc).month, day=datetime.now(timezone.utc).day).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            except ValueError:
                pass
    return None
_inspect_cache: Dict[tuple, dict] = {}


class ClaudeAdapter(Adapter):
    provider_id = "claude"

    # ---- declaration -------------------------------------------------------------------------
    def capabilities(self) -> dict:
        return {"headless": True, "structuredProgress": True, "structuredFinal": True, "resume": UNSUPPORTED,
                "interactiveInput": UNSUPPORTED}

    def policy_mapping(self) -> Dict[str, Optional[List[str]]]:
        return {p: list(POLICY_FLAGS[p]) for p in POLICIES}

    def reasoning_levels(self):
        return REASONING

    def model_selectable(self) -> bool:
        return True

    def supports_deep_probe(self) -> bool:
        return True

    # ---- installed CLI ------------------------------------------------------------------------
    def executable(self, env: dict) -> Optional[str]:
        return shutil.which("claude", path=env.get("PATH", ""))

    def inspect(self, env: dict) -> dict:
        exe = self.executable(env)
        if not exe:
            return {"found": False}
        real = os.path.realpath(exe)
        key = (real, os.stat(real).st_mtime_ns)
        if key in _inspect_cache:
            return _inspect_cache[key]
        try:
            ver = cli_support.run_quiet([exe, "--version"], env, ENV)
            version_text = ver.stdout.decode("utf-8", "replace").strip()
            if ver.returncode != 0 or not version_text:
                err = short(ver.stderr.decode("utf-8", "replace") or f"exit {ver.returncode}", 200)
                return {"found": True, "path": exe, "error": f"`claude --version` failed: {err}"}
            hlp = cli_support.run_quiet([exe, "--help"], env, ENV)
        except (OSError, subprocess.SubprocessError) as e:
            return {"found": True, "path": exe, "error": f"could not run claude: {e}"}
        m = re.search(r"(\d+\.\d+\.\d+\S*)", version_text)
        help_text = hlp.stdout.decode("utf-8", "replace")
        info = {"found": True, "path": exe, "version": m.group(1) if m else version_text[:60],
                "versionText": version_text[:120],
                "missingFlags": [f for f in REQUIRED_FLAGS if f not in help_text]
                + [f"--permission-mode {x}" for x in REQUIRED_MODES if f'"{x}"' not in help_text]}
        _inspect_cache[key] = info
        return info

    def version(self, env: dict) -> Optional[str]:
        return self.inspect(env).get("version")

    def login_status(self, env: dict) -> dict:
        try:
            p = cli_support.run_quiet([self.executable(env), "auth", "status"], env, ENV)
        except (OSError, subprocess.SubprocessError) as e:
            return {"loggedIn": False, "detail": f"auth status could not run: {e}"}
        text = p.stdout.decode("utf-8", "replace")
        try:
            data = json.loads(text)
            return {"loggedIn": bool(data.get("loggedIn")) and p.returncode == 0, "method": data.get("authMethod"),
                    "apiProvider": data.get("apiProvider")}
        except ValueError:
            return {"loggedIn": p.returncode == 0 and "not logged in" not in text.lower(), "method": None}

    def probe(self, env: dict, deep: bool = False) -> dict:
        d = self.describe(env)
        info = self.inspect(env)
        if not info.get("found"):
            return dict(d, available=False, code="PROVIDER_NOT_FOUND",
                        reason="claude was not found on the login PATH (install: npm install -g @anthropic-ai/claude-code).")
        if info.get("error"):
            return dict(d, available=False, executable=info["path"], reason=info["error"])
        if info["missingFlags"]:
            return dict(d, available=False, executable=info["path"], code="CAPABILITY_GAP",
                        reason=f"claude {info['version']} lacks required options: {', '.join(info['missingFlags'])}.")
        login = self.login_status(env)
        if not login["loggedIn"]:
            return dict(d, available=False, executable=info["path"], code="AUTH_REQUIRED",
                        reason="claude is not logged in (run: claude auth login).")
        out = dict(d, available=True, executable=info["path"], login=login)
        return cli_support.apply_deep(out, self, info, env, deep)

    # ---- execution ----------------------------------------------------------------------------
    def _mcp_config(self, inp: AssignmentInput) -> Optional[str]:
        """The per-assignment MCP config for `--mcp-config`: only the Agent Studio board server, so
        `--strict-mcp-config` still means 'nothing but what Agent Studio passes' (P04-S12)."""
        from ..base import mcp_env, mcp_launch
        launch = mcp_launch()
        config = {"mcpServers": {"agent-studio": {
            "type": "stdio", "command": launch["command"], "args": launch["args"],
            "env": dict(launch["env"], **mcp_env(inp.assignment_id, inp.agent_id, inp.workspace))}}}
        path = os.path.join(os.path.dirname(inp.prompt_path), "mcp.json")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(config, f)
        return path

    def _prepare(self, inp: AssignmentInput, env: dict) -> Prepared:
        exe = self.executable(env)
        if not exe:
            raise AsError("PROVIDER_UNAVAILABLE", "claude was not found on the login PATH.")
        self.validate_settings(inp.model, inp.reasoning)
        extra_env, mcp_path = {}, None
        if inp.mcp_tickets:
            mcp_path = self._mcp_config(inp)
            extra_env.update(mcp_env(inp.assignment_id, inp.agent_id, inp.workspace))
        if commands_enabled(inp.workspace):
            argv = [exe] + [a for a in COMMON if a != "--restricted"] + COMMAND_FLAGS[inp.policy]
            banned = [a for a in NEVER if a != "Bash"]
        else:
            argv, banned = [exe] + COMMON + POLICY_FLAGS[inp.policy], NEVER
        if mcp_path:
            # `dontAsk` / `--permission-prompts none` deny anything not allowlisted, so the board tools must be
            # named; only these five, only for assignments that enabled the server.
            i = argv.index("--allowedTools")
            argv[i + 1] = ",".join([argv[i + 1]] + MCP_TOOLS)
            argv += ["--mcp-config", mcp_path]
        if any(a in banned for a in argv):
            raise AsError("BAD_ADAPTER", "refusing a permission-bypass flag or a code-running tool")
        if inp.model:
            argv += ["--model", inp.model]
        if inp.reasoning:
            argv += ["--effort", inp.reasoning]
        # The prompt arrives on stdin (the private prompt file); the workspace is the working directory.
        return Prepared(argv=argv, env_allowlist=ENV, stdin_path=inp.prompt_path, cwd=inp.workspace,
                        extra_env=extra_env, mcp_config_path=mcp_path)

    def parse_line(self, line: bytes, state: ParseState):
        state.events += 1
        try:
            ev = json.loads(line.decode("utf-8"))
            if not isinstance(ev, dict):
                raise ValueError
        except UnicodeDecodeError:
            state.malformed += 1
            return [("attention", "claude output line is not UTF-8")]
        except ValueError:
            text = line.decode("utf-8", "replace").strip()
            if text.startswith("{"):
                state.malformed += 1
                return [("attention", "unparseable claude output line")]
            if text and AUTH_RE.search(text):
                return [("attention", short(text))]
            return [("progress", short(text))] if text else []
        t, sub = ev.get("type"), ev.get("subtype")
        if t == "system":
            if sub == "init":
                state.session_id = str(ev.get("session_id", ""))[:100] or None
                return [("progress", f"claude session {state.session_id} model {short(ev.get('model', '?'), 60)} "
                                     f"mode {ev.get('permissionMode')}")]
            if sub == "api_retry":
                return [("attention", f"API retry {ev.get('attempt')}/{ev.get('max_retries')} "
                                      f"({ev.get('error_status') or ev.get('error')})")]
            if sub == "permission_denied":
                item = f"{ev.get('tool_name', '?')}: {short(ev.get('decision_reason') or '', 160)}"
                state.extra.setdefault("streamDenials", []).append(item)
                return [("attention", f"permission denied - {item}")]
            return []
        if t == "assistant":
            out = []
            for c in (ev.get("message") or {}).get("content") or []:
                if not isinstance(c, dict):
                    continue
                if c.get("type") == "text" and c.get("text"):
                    state.final_text = c["text"]
                    out.append(("progress", "message: " + short(c["text"], 200)))
                elif c.get("type") == "tool_use":
                    inp = c.get("input") if isinstance(c.get("input"), dict) else {}
                    target = inp.get("file_path") or inp.get("pattern") or inp.get("path") or ""
                    out.append(("progress", f"tool {c.get('name')} {short(target, 160)}".rstrip()))
            return out
        if t == "user":
            out = []
            for c in (ev.get("message") or {}).get("content") or []:
                if isinstance(c, dict) and c.get("type") == "tool_result" and c.get("is_error"):
                    out.append(("attention", "tool error: " + short(c.get("content"), 200)))
            return out
        if t == "result":
            state.session_id = str(ev.get("session_id") or state.session_id or "")[:100] or None
            usage = ev.get("usage") if isinstance(ev.get("usage"), dict) else {}
            state.usage = {k: v for k, v in usage.items() if isinstance(v, int) and not isinstance(v, bool)}
            if isinstance(ev.get("total_cost_usd"), (int, float)):
                state.usage["total_cost_micro_usd"] = int(round(ev["total_cost_usd"] * 1_000_000))
            denials = ev.get("permission_denials")
            if isinstance(denials, list):  # the authoritative record of denials for the run
                for d in denials[:20]:
                    if isinstance(d, dict):
                        ti = d.get("tool_input") if isinstance(d.get("tool_input"), dict) else {}
                        state.denials.append(f"{d.get('tool_name', '?')}: "
                                             f"{short(ti.get('file_path') or ti.get('command') or '', 160)}")
            text = ev.get("result") if isinstance(ev.get("result"), str) else ""
            if text:
                state.final_text = text
            ok = sub == "success" and not ev.get("is_error")
            if ok:
                state.terminal = {"ok": True, "summary": (text or "claude finished")[:2000]}
                return [("progress", f"result: {ev.get('terminal_reason') or 'completed'}")]
            code = "AUTH_REQUIRED" if AUTH_RE.search(text or "") else ("USAGE_LIMIT" if LIMIT_RE.search(text or "") else "PROVIDER_ERROR")
            reason = ev.get("terminal_reason") or sub
            state.terminal = {"ok": False, "code": code,
                              "summary": short(text or f"claude ended with {reason}", 2000)}
            if code == "USAGE_LIMIT":
                reset = limit_reset_at(text)
                if reset:
                    state.terminal["limitResetAt"] = reset
            return [("attention", f"result {reason}: {short(text, 200)}")]
        return []

    def finalize(self, inp: AssignmentInput, st: ParseState, oc: dict) -> dict:
        if st.terminal is None and st.extra.get("streamDenials") and not st.denials:
            st.denials.extend(st.extra["streamDenials"])  # no final result: keep what the stream reported
        return super().finalize(inp, st, oc)
