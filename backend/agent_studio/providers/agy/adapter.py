"""Headless agy integration; workspace isolation is an explicit operator exception."""
import json
import os
import re
import shutil
import subprocess

from ...protocol import AsError
from .. import cli_support
from ..base import BASE_ENV, UNSUPPORTED, Adapter, Prepared

ENV = BASE_ENV + ("HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR")
FLAGS = ("--input-format", "--output-format", "--mode", "--sandbox", "--model", "--effort")
WARNING = ("agy workspace_write is an operator-approved exception: workspace-only isolation is not guaranteed; "
           "global settings may allow external writes and the terminal sandbox may be unavailable. "
           "agy does not support read_only assignments.")
DENIAL = re.compile(r"permission.{0,40}(denied|rejected|not granted)|(?:denied|rejected).{0,40}permission|soft.denied", re.I)
AUTH = re.compile(r"authentication required|not authenticated|not logged in|sign in|unauthorized|\b401\b", re.I)


def commands_enabled(workspace: str) -> bool:
    try:
        with open(os.path.join(workspace, ".agent-studio", "permissions.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        agy = cfg.get("agy") or {}
        return cfg.get("version") == 1 and (agy.get("commands") is True or agy.get("dangerouslySkipPermissions") is True)
    except (OSError, ValueError, AttributeError):
        return False


class AgyAdapter(Adapter):
    provider_id = "agy"

    def capabilities(self):
        return {"headless": True, "structuredProgress": True, "structuredFinal": True,
                "resume": UNSUPPORTED, "interactiveInput": UNSUPPORTED}

    def policy_mapping(self):
        return {"read_only": None, "workspace_write": ["--mode", "accept-edits", "--sandbox"]}

    def reasoning_levels(self):
        return ("low", "medium", "high", "xhigh", "max")

    def model_selectable(self):
        return True

    def executable(self, env):
        path = os.pathsep.join(p for p in env.get("PATH", "").split(os.pathsep) if p)
        return (shutil.which("agy", path=path) or shutil.which("antigravity", path=path)) if path else None

    def inspect(self, env):
        exe = self.executable(env)
        if not exe:
            return {"found": False}
        try:
            ver = cli_support.run_quiet([exe, "--version"], env, ENV)
            help_result = cli_support.run_quiet([exe, "--help"], env, ENV)
            version = ver.stdout.decode("utf-8", "replace").strip()
            help_text = (help_result.stdout + help_result.stderr).decode("utf-8", "replace")
            if ver.returncode or help_result.returncode or not version:
                return {"found": True, "path": exe, "error": "agy version or help command failed"}
            missing = [f for f in FLAGS if f not in help_text]
            if "accept-edits" not in help_text or "stream-json" not in help_text:
                missing.append("accept-edits or stream-json")
            return {"found": True, "path": exe, "version": version[:120], "missing": missing}
        except (OSError, subprocess.SubprocessError) as exc:
            return {"found": True, "path": exe, "error": str(exc)}

    def version(self, env):
        return self.inspect(env).get("version")

    def describe(self, env):
        return dict(super().describe(env), warning=WARNING)

    def probe(self, env, deep=False):
        info = self.inspect(env)
        description = self.describe(env)
        if not info.get("found"):
            return dict(description, available=False, code="PROVIDER_NOT_FOUND", reason="agy was not found on the login PATH.")
        if info.get("error") or info.get("missing"):
            return dict(description, available=False, executable=info["path"], code="CAPABILITY_GAP",
                        reason=info.get("error") or "agy lacks required options: " + ", ".join(info["missing"]))
        return dict(description, available=True, executable=info["path"], authVerified=False, warning=WARNING, warnings=[WARNING])

    def _prepare(self, inp, env):
        info = self.inspect(env)
        if not info.get("found"):
            raise AsError("PROVIDER_UNAVAILABLE", "agy was not found on the login PATH.")
        if info.get("error") or info.get("missing"):
            raise AsError("PROVIDER_UNAVAILABLE", "agy does not support the required headless options.")
        self.validate_settings(inp.model, inp.reasoning)
        if inp.mcp_tickets:
            raise AsError("POLICY_UNSUPPORTED", "agy does not support assignment-scoped Agent Studio MCP configuration.")
        with open(inp.prompt_path, encoding="utf-8") as source:
            prompt = source.read()
        path = os.path.join(os.path.dirname(inp.prompt_path), "agy-input.jsonl")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump({"event": "user", "message": {"content": prompt}}, output)
            output.write("\n")
        flags = list(self.policy_mapping()[inp.policy])
        if commands_enabled(inp.workspace):
            flags.append("--dangerously-skip-permissions")
        argv = [info["path"], "--input-format", "stream-json", "--output-format", "stream-json"] + flags
        if inp.model:
            argv += ["--model", inp.model]
        if inp.reasoning:
            argv += ["--effort", inp.reasoning]
        return Prepared(argv=argv, env_allowlist=ENV, stdin_path=path, cwd=inp.workspace)

    def parse_line(self, line, state):
        state.events += 1
        try:
            event = json.loads(line.decode("utf-8"))
            if not isinstance(event, dict):
                raise ValueError()
        except (UnicodeDecodeError, ValueError):
            state.malformed += 1
            return [("attention", "invalid agy stream event")]
        kind = event.get("event")
        if kind == "init":
            state.session_id = str(event.get("conversation_id") or "")[:100] or None
            return [("progress", "agy session started")]
        if kind == "step_update":
            step = event.get("step_update")
            if not isinstance(step, dict):
                state.malformed += 1
                return [("attention", "invalid agy step")]
            tool = step.get("tool_info") or {}
            error = tool.get("error") if isinstance(tool, dict) else None
            message = str(error.get("message") or error.get("type") or "") if isinstance(error, dict) else str(error or "")
            if DENIAL.search(message):
                state.denials.append(cli_support.short(message))
                return [("attention", "permission denied: " + cli_support.short(message))]
            text = step.get("text_delta")
            if isinstance(text, str) and text.strip():
                return [("progress", "message: " + cli_support.short(text, 200))]
            return []
        if kind == "result":
            result = event.get("result")
            if not isinstance(result, dict) or result.get("status") not in ("SUCCESS", "ERROR", "CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING"):
                state.malformed += 1
                return [("attention", "invalid agy result")]
            state.session_id = str(result.get("conversation_id") or state.session_id or "")[:100] or None
            state.final_text = result.get("response") if isinstance(result.get("response"), str) else None
            usage = result.get("usage")
            if isinstance(usage, dict):
                state.usage = {k: v for k, v in usage.items() if isinstance(v, int) and not isinstance(v, bool) and v >= 0}
            status = result["status"]
            message = str(result.get("error") or state.final_text or status)
            if status == "SUCCESS":
                state.terminal = {"ok": True, "summary": message[:2000]}
            elif status in ("WAITING", "RUNNING"):
                state.input_requests.append(cli_support.short(message))
            else:
                code = "AUTH_REQUIRED" if AUTH.search(message) else "USAGE_LIMIT" if cli_support.LIMIT_RE.search(message) else "PROVIDER_ERROR"
                state.terminal = {"ok": False, "code": code, "summary": cli_support.short(message, 2000)}
                reset = cli_support.limit_reset_at(message) if code == "USAGE_LIMIT" else None
                if reset:
                    state.terminal["limitResetAt"] = reset
            return [("progress" if status == "SUCCESS" else "attention", "agy result: " + status)]
        return []

    def finalize(self, inp, state, outcome):
        try:
            with open(outcome.get("stderrPath") or "", encoding="utf-8", errors="replace") as stderr:
                diagnostics = stderr.read(256 * 1024)
        except OSError:
            diagnostics = ""
        for line in diagnostics.splitlines():
            if DENIAL.search(line):
                state.denials.append(cli_support.short(line))
        if state.terminal is None and diagnostics and (AUTH.search(diagnostics) or cli_support.LIMIT_RE.search(diagnostics)):
            code = "AUTH_REQUIRED" if AUTH.search(diagnostics) else "USAGE_LIMIT"
            state.terminal = {"ok": False, "code": code, "summary": cli_support.short(diagnostics, 2000)}
        return super().finalize(inp, state, outcome)

