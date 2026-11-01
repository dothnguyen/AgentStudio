"""OpenCode adapter (P00-S11). Verified against the installed CLI, opencode v2.2.5 (`--version`,
`run --help`, `auth list`, `debug --standalone agents`, and real `run --format json` runs); see CONTRACT.md.
Nothing here guesses a flag: the installed CLI's help and config loader are checked at probe time.

v2.2.5 reads a per-process configuration from `OPENCODE_CONFIG_CONTENT`, so Agent Studio can inject an
ordered `permissions` rule list for exactly one run. That is the run-scoped permission mapping the v2.1.4
adapter could not provide. The workspace's own project configuration is disabled for the run, so an agent
cannot widen its permissions by editing `opencode.json`.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from ...protocol import AsError
from .. import cli_support
from ..base import (BASE_ENV, POLICIES, UNSUPPORTED, Adapter, AssignmentInput, ParseState, Prepared,
                    mcp_env, mcp_launch)

REQUIRED_FLAGS = ("--format", "--model", "--agent", "--session", "--standalone", "--log-level")
# `--auto` auto-approves every permission that is not explicitly denied: the bypass analog. `--continue` /
# `--session` reuse another session; the runner never resumes.
NEVER = ("--auto", "--continue", "-c")
SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$")
CONFIG_ENV = "OPENCODE_CONFIG_CONTENT"
PROJECT_CONFIG_ENV = "OPENCODE_DISABLE_PROJECT_CONFIG"  # never let a workspace config widen the run's rules
CANARY_ACTION = "agent-studio-probe"
ENV = BASE_ENV + ("OPENCODE_API_KEY", "OPENCODE_BASE_URL", "OPENCODE_LOG_LEVEL",
                  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
                  "SSL_CERT_FILE", "SSL_CERT_DIR")
DENIAL = re.compile(r"permission.{0,40}(denied|rejected|not granted)|(?:denied|rejected).{0,40}permission"
                    r"|permission required|auto[- ]reject", re.I)
# Read-only commands, mirroring the claude adapter's opt-in allowlist (P01-S09b).
READ_COMMANDS = ["git status", "git diff", "git log", "git show", "git ls-files", "git rev-parse", "git grep",
                 "git blame", "git merge-base", "git branch", "ls", "cat", "head", "tail", "wc", "grep", "sort",
                 "uniq", "pwd", "cd", "python3 -m unittest", "python3 -W ignore -m unittest", "python3 -m pytest",
                 "rg", "ctags -f -"]

# Ordered rules; the last matching rule wins (v2 permissions model). The base policy starts with
# {"action": "*", "resource": "*", "effect": "allow"}, so a deny must follow it; exceptions follow the deny.
READ_ONLY = [
    {"action": "edit", "resource": "*", "effect": "deny"},
    {"action": "shell", "resource": "*", "effect": "deny"},
    {"action": "execute", "resource": "*", "effect": "deny"},
    {"action": "webfetch", "resource": "*", "effect": "deny"},
    {"action": "websearch", "resource": "*", "effect": "deny"},
    {"action": "external_directory", "resource": "*", "effect": "deny"},
    {"action": "question", "resource": "*", "effect": "deny"},
]
WORKSPACE_WRITE = [
    {"action": "edit", "resource": "*", "effect": "allow"},
    {"action": "external_directory", "resource": "*", "effect": "deny"},
    {"action": "webfetch", "resource": "*", "effect": "deny"},
    {"action": "websearch", "resource": "*", "effect": "deny"},
    {"action": "question", "resource": "*", "effect": "deny"},
    {"action": "shell", "resource": "*", "effect": "deny"},
]
_inspect_cache: Dict[tuple, dict] = {}


def _short(text: str, n: int = 300) -> str:
    return " ".join(str(text).split())[:n]


def _install_fallback() -> str:
    return os.path.join(os.path.expanduser("~"), ".opencode", "bin", "opencode")


def commands_enabled(workspace: str) -> bool:
    """Opt-in command access: `.agent-studio/permissions.json` {"version": 1, "opencode": {"commands": true}}."""
    try:
        with open(os.path.join(workspace, ".agent-studio", "permissions.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        return cfg.get("version") == 1 and (cfg.get("opencode") or {}).get("commands") is True
    except (OSError, ValueError, AttributeError):
        return False


def policy_rules(policy: str, commands: bool) -> List[dict]:
    """The ordered permissions list for a policy. `commands` adds the workspace's opt-in command access."""
    if policy == "read_only":
        rules = [dict(r) for r in READ_ONLY]
        if commands:
            rules += [{"action": "shell", "resource": c + " *", "effect": "allow"} for c in READ_COMMANDS]
        return rules
    rules = [dict(r) for r in WORKSPACE_WRITE]
    if commands:
        rules.append({"action": "shell", "resource": "*", "effect": "allow"})
    return rules


def _config_content(policy: str, commands: bool) -> str:
    return json.dumps({"permissions": policy_rules(policy, commands)}, separators=(",", ":"))


def _usage(part: dict) -> Optional[dict]:
    tokens = part.get("tokens") if isinstance(part.get("tokens"), dict) else {}
    usage = {k: v for k, v in tokens.items() if isinstance(v, int) and not isinstance(v, bool)}
    cache = tokens.get("cache") if isinstance(tokens.get("cache"), dict) else {}
    for key, value in cache.items():
        if isinstance(value, int) and not isinstance(value, bool):
            usage["cache_" + key] = value
    if isinstance(part.get("cost"), (int, float)) and not isinstance(part.get("cost"), bool):
        usage["total_cost_micro_usd"] = int(round(part["cost"] * 1_000_000))
    return usage or None


class OpenCodeAdapter(Adapter):
    provider_id = "opencode"
    supports_session_resume = True   # `opencode run --session <id>`; used only after delegated commands (P06)

    # ---- declaration -------------------------------------------------------------------------
    def capabilities(self) -> dict:
        return {"headless": True, "structuredProgress": True, "structuredFinal": True, "resume": UNSUPPORTED,
                "interactiveInput": UNSUPPORTED}

    def policy_mapping(self) -> Dict[str, Optional[List[str]]]:
        # The mapping is a per-process environment value, not an argv flag; prepare replaces the no-command
        # rules with the workspace's opt-in command set when permissions.json enables it.
        return {p: [CONFIG_ENV, _config_content(p, False)] for p in POLICIES}

    def reasoning_levels(self):
        # `run --help` has no reasoning flag; model variants (`--model provider/model#variant`) are
        # model-specific and unverified. Refuse reasoning until a variant scheme is verified.
        return ()

    def model_selectable(self) -> bool:
        return True  # verified: `--model, -m string   Model to use in the format provider/model#variant`

    def supports_deep_probe(self) -> bool:
        return True

    # ---- installed CLI ------------------------------------------------------------------------
    def executable(self, env: dict) -> Optional[str]:
        found = shutil.which("opencode", path=env.get("PATH", ""))
        if found:
            return found
        fallback = _install_fallback()  # the installer's default location; not on the login PATH by default
        return fallback if os.path.isfile(fallback) and os.access(fallback, os.X_OK) else None

    def _config_injection(self, exe: str, env: dict) -> bool:
        """Prove the CLI honours OPENCODE_CONFIG_CONTENT by asking its own config merge for a canary rule."""
        run_env = {k: env[k] for k in ENV if k in env}
        run_env[CONFIG_ENV] = json.dumps({"permissions": [{"action": CANARY_ACTION, "resource": "*",
                                                           "effect": "deny"}]})
        run_env[PROJECT_CONFIG_ENV] = "1"
        try:
            p = subprocess.run([exe, "debug", "--standalone", "agents"], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=run_env,
                               cwd=tempfile.gettempdir(), timeout=30)
        except (OSError, subprocess.SubprocessError):
            return False
        return p.returncode == 0 and CANARY_ACTION in p.stdout.decode("utf-8", "replace")

    def inspect(self, env: dict) -> dict:
        exe = self.executable(env)
        if not exe:
            return {"found": False}
        real = os.path.realpath(exe)
        key = (real, os.stat(real).st_mtime_ns)
        if key in _inspect_cache:
            return _inspect_cache[key]
        run_env = {k: env[k] for k in ENV if k in env}
        try:
            ver = subprocess.run([exe, "--version"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, env=run_env, timeout=30)
            hlp = subprocess.run([exe, "run", "--help"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, env=run_env, timeout=30)
        except (OSError, subprocess.SubprocessError) as e:
            return {"found": True, "path": exe, "error": f"could not run opencode: {e}"}
        version_text = ver.stdout.decode("utf-8", "replace").strip()
        if ver.returncode != 0 or not version_text:
            err = _short(ver.stderr.decode("utf-8", "replace") or f"exit {ver.returncode}", 200)
            return {"found": True, "path": exe, "error": f"`opencode --version` failed: {err}"}
        m = re.search(r"(\d+\.\d+\.\d+\S*)", version_text)
        help_text = hlp.stdout.decode("utf-8", "replace")
        missing = [f for f in REQUIRED_FLAGS if f not in help_text]
        if "json" not in help_text:
            missing.append("--format json")
        info = {"found": True, "path": exe, "version": m.group(1) if m else version_text[:60],
                "versionText": version_text[:120], "missingFlags": missing,
                "configInjection": self._config_injection(exe, env)}
        _inspect_cache[key] = info
        return info

    def version(self, env: dict) -> Optional[str]:
        return self.inspect(env).get("version")

    def login_status(self, env: dict) -> dict:
        exe = self.executable(env)
        run_env = {k: env[k] for k in ENV if k in env}
        try:
            p = subprocess.run([exe, "auth", "list"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=run_env, timeout=30)
        except (OSError, subprocess.SubprocessError) as e:
            return {"loggedIn": False, "detail": f"auth list could not run: {e}"}
        text = p.stdout.decode("utf-8", "replace")
        # verified v2 output: one line per credential, "<provider>  <name>  stored"
        stored = [line.split()[0] for line in text.splitlines() if " stored" in line]
        return {"loggedIn": bool(stored), "method": stored[0] if stored else None}

    def probe(self, env: dict, deep: bool = False) -> dict:
        d = self.describe(env)
        info = self.inspect(env)
        if not info.get("found"):
            return dict(d, available=False, code="PROVIDER_NOT_FOUND",
                        reason="opencode was not found on the login PATH or in ~/.opencode/bin "
                               "(install: curl -fsSL https://opencode.ai/install | bash).")
        if info.get("error"):
            return dict(d, available=False, executable=info["path"], reason=info["error"])
        if info["missingFlags"]:
            return dict(d, available=False, executable=info["path"], code="CAPABILITY_GAP",
                        reason=f"opencode {info['version']} lacks required run options: "
                               f"{', '.join(info['missingFlags'])}.")
        login = self.login_status(env)
        if not login["loggedIn"]:
            return dict(d, available=False, executable=info["path"], code="AUTH_REQUIRED",
                        reason="opencode has no stored credential (run: opencode auth login).")
        if not info.get("configInjection"):
            return dict(d, available=False, executable=info["path"], code="CAPABILITY_GAP",
                        reason=f"opencode {info['version']} does not honour {CONFIG_ENV}, so Agent Studio "
                               f"cannot inject run-scoped permissions. See providers/opencode/CONTRACT.md.",
                        login=login)
        out = dict(d, available=True, executable=info["path"], login=login)
        return cli_support.apply_deep(out, self, info, env, deep)

    # ---- execution ----------------------------------------------------------------------------
    def _config(self, inp: AssignmentInput) -> dict:
        config = {"permissions": policy_rules(inp.policy, commands_enabled(inp.workspace))}
        if inp.mcp_tickets or inp.mcp_delegation:  # the Agent Studio board server, per assignment (P04-S12)
            launch = mcp_launch()
            config["mcp"] = {"servers": {"agent-studio": {
                "type": "local",
                "command": [launch["command"]] + launch["args"],
                "environment": dict(launch["env"], **mcp_env(inp.assignment_id, inp.agent_id,
                                                             inp.mcp_workspace or inp.workspace)),
                "codemode": False,
            }}}
        return config

    def _prepare(self, inp: AssignmentInput, env: dict) -> Prepared:
        exe = self.executable(env)
        if not exe:
            raise AsError("PROVIDER_UNAVAILABLE", "opencode was not found on the login PATH.")
        self.validate_settings(inp.model, inp.reasoning)
        if self.policy_mapping().get(inp.policy) is None:
            raise AsError("POLICY_UNSUPPORTED", f"opencode has no verified mapping for {inp.policy}.")
        # `--standalone`: a private server per run instead of the shared background service — the service
        # pins its config at start, and Agent Studio never touches a server it did not create.
        argv = [exe, "run", "--standalone", "--format", "json", "--log-level", "none"]
        if any(a in NEVER for a in argv):
            raise AsError("BAD_ADAPTER", "refusing an auto-approval or session-reuse flag")
        if inp.model:
            argv += ["--model", inp.model]
        if inp.provider_session_id:
            if not SESSION_ID.match(inp.provider_session_id):
                raise AsError("BAD_ADAPTER", "refusing a provider session id of an unexpected form")
            argv += ["--session", inp.provider_session_id]
        extra_env = {CONFIG_ENV: json.dumps(self._config(inp), separators=(",", ":")),
                     PROJECT_CONFIG_ENV: "1"}
        # no message argument: the prompt comes from stdin (the private prompt file), never the command line
        return Prepared(argv=argv, env_allowlist=ENV, stdin_path=inp.prompt_path, cwd=inp.workspace,
                        extra_env=extra_env)

    def parse_line(self, line: bytes, state: ParseState):
        state.events += 1
        try:
            ev = json.loads(line.decode("utf-8"))
            if not isinstance(ev, dict):
                raise ValueError
        except UnicodeDecodeError:
            state.malformed += 1
            return [("attention", "opencode output line is not UTF-8")]
        except ValueError:
            text = line.decode("utf-8", "replace").strip()
            if text.startswith("{"):
                state.malformed += 1
                return [("attention", "unparseable opencode output line")]
            return [("progress", _short(text))] if text else []
        sid = ev.get("sessionID")
        if isinstance(sid, str) and sid and not state.session_id:
            state.session_id = sid[:100]
        t = ev.get("type")
        if t == "step_start":
            return [("progress", f"opencode session {state.session_id}")]
        if t == "error":
            # verified: the CLI exits 0 even on a provider error, so the error event is the only
            # authoritative failure signal. Terminal: the run produced no reply.
            return self._error(ev, state)
        part = ev.get("part") if isinstance(ev.get("part"), dict) else None
        if part is not None:  # every text/tool/step-finish event carries the part (documented in CONTRACT.md)
            return self._part(part, state)
        return []

    def _error(self, ev: dict, state: ParseState):
        err = ev.get("error")
        if not isinstance(err, dict):
            err = {"message": str(err or "")}
        kind = str(err.get("type") or "")
        msg = str(err.get("message") or "")
        full = f"{msg} {kind}"
        status = err.get("status")
        if kind == "provider.auth" or status == 401 or cli_support.AUTH_RE.search(full):
            code = "AUTH_REQUIRED"
        elif ("limit" in kind or "quota" in kind or status == 429
              or cli_support.LIMIT_RE.search(full)):
            code = "USAGE_LIMIT"
        else:
            code = "PROVIDER_ERROR"
        state.terminal = {"ok": False, "code": code, "summary": _short(msg or f"opencode error ({kind})", 2000)}
        if code == "USAGE_LIMIT":
            reset = cli_support.limit_reset_at(full)
            retry_ms = ev.get("retryAfterMs", err.get("retryAfterMs"))
            if reset is None and isinstance(retry_ms, (int, float)) and not isinstance(retry_ms, bool):
                reset = (datetime.now(timezone.utc) + timedelta(milliseconds=retry_ms)).strftime(
                    "%Y-%m-%dT%H:%M:%SZ")
            if reset:
                state.terminal["limitResetAt"] = reset
        return [("attention", f"error ({kind or 'unknown'}): {_short(msg, 200)}")]

    def _part(self, part: dict, state: ParseState):
        kind = part.get("type")
        if kind == "text" and isinstance(part.get("text"), str):
            state.final_text = part["text"]
            return [("progress", "message: " + _short(part["text"], 200))]
        if kind == "reasoning" and isinstance(part.get("text"), str):
            return [("progress", "thinking: " + _short(part["text"], 160))]
        if kind == "step-finish":
            usage = _usage(part)
            if usage:
                state.usage = dict(state.usage or {}, **usage)
            reason = str(part.get("reason") or "")
            if reason == "stop" and state.terminal is None:  # intermediate steps finish with "tool-calls"
                state.terminal = {"ok": True, "summary": (state.final_text or "opencode finished")[:2000]}
                return [("progress", "step finished")]
            return [("progress", f"step finished ({reason})" if reason else "step finished")]
        if kind == "tool" and isinstance(part.get("tool"), str):
            return self._tool(part, state)
        return []

    def _tool(self, part: dict, state: ParseState):
        tool = part["tool"]
        raw_state = part.get("state")
        status, error, detail = None, None, ""
        if isinstance(raw_state, dict):
            status = raw_state.get("status")
            err = raw_state.get("error")
            if isinstance(err, dict):
                error = err.get("message") or err.get("type")
            elif err:
                error = err
            given = raw_state.get("input")
            if isinstance(given, dict):
                detail = str(given.get("path") or given.get("command") or given.get("query")
                             or given.get("description") or given.get("prompt") or "")
        else:
            status = raw_state  # v2.1.x shape: state was the status string and error sat beside it
            error = part.get("error")
        if status == "error" or error:
            message = _short(error or "tool failed", 240)
            if DENIAL.search(message):
                state.denials.append(f"{tool}: {message}")
                return [("attention", f"permission denied - {tool}: {message}")]
            return [("attention", f"tool {tool} failed: {message}")]
        return [("progress", f"tool {tool} {status or ''} {_short(detail, 160)}".rstrip())]
