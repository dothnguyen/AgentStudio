"""Codex CLI adapter (P00-S08). Verified against codex-cli 0.163.0 (`codex exec --help`, real JSONL output);
see CONTRACT.md. Nothing here guesses a flag: the installed CLI's help is checked for every flag we use."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from typing import Dict, List, Optional

from ...protocol import AsError
from ..base import (BASE_ENV, POLICIES, UNSUPPORTED, Adapter, AssignmentInput, ParseState, Prepared)

REQUIRED_FLAGS = ("--json", "--sandbox", "--model", "--config", "--skip-git-repo-check", "--ephemeral", "--color",
                  "--cd")
NEVER = ("--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--approve-for-me",
         "danger-full-access", "--full-auto", "--yolo")
REASONING = ("minimal", "low", "medium", "high", "xhigh")
APPROVAL = ["-c", 'approval_policy="never"']   # headless: never stop to ask; blocked commands simply fail
POLICY_FLAGS = {
    "read_only": ["--sandbox", "read-only"] + APPROVAL,
    "workspace_write": ["--sandbox", "workspace-write"] + APPROVAL + ["-c", "sandbox_workspace_write.network_access=false"],
}
ENV = BASE_ENV + ("CODEX_HOME", "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORGANIZATION",
                  "OPENAI_PROJECT", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
                  "SSL_CERT_FILE", "SSL_CERT_DIR")
PROBE_TOKEN = "AGENT_STUDIO_OK"
DEEP_PROBE_TTL_S = 24 * 3600
_inspect_cache: Dict[tuple, dict] = {}


def _short(text: str, n: int = 300) -> str:
    return " ".join(str(text).split())[:n]


class CodexAdapter(Adapter):
    provider_id = "codex"

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
        return shutil.which("codex", path=env.get("PATH", ""))

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
            hlp = subprocess.run([exe, "exec", "--help"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, env=run_env, timeout=30)
        except (OSError, subprocess.SubprocessError) as e:
            return {"found": True, "path": exe, "error": f"could not run codex: {e}"}
        version_text = ver.stdout.decode("utf-8", "replace").strip()
        if ver.returncode != 0 or not version_text:
            err = _short(ver.stderr.decode("utf-8", "replace") or f"exit {ver.returncode}", 200)
            return {"found": True, "path": exe, "error": f"`codex --version` failed: {err}"}
        m = re.search(r"(\d+\.\d+\.\d+\S*)", version_text)
        help_text = hlp.stdout.decode("utf-8", "replace")
        info = {"found": True, "path": exe, "version": m.group(1) if m else version_text[:60],
                "versionText": version_text[:120],
                "missingFlags": [f for f in REQUIRED_FLAGS if f not in help_text],
                "sandboxModes": [s for s in ("read-only", "workspace-write") if s in help_text]}
        _inspect_cache[key] = info
        return info

    def version(self, env: dict) -> Optional[str]:
        info = self.inspect(env)
        return info.get("version")

    def login_status(self, env: dict) -> dict:
        exe = self.executable(env)
        run_env = {k: env[k] for k in ENV if k in env}
        try:
            p = subprocess.run([exe, "login", "status"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=run_env, timeout=30)
        except (OSError, subprocess.SubprocessError) as e:
            return {"loggedIn": False, "detail": f"login status could not run: {e}"}
        text = (p.stdout + p.stderr).decode("utf-8", "replace")
        method = "ChatGPT" if "ChatGPT" in text else ("API key" if "API key" in text else None)
        return {"loggedIn": p.returncode == 0 and "Not logged in" not in text, "method": method}

    def probe(self, env: dict, deep: bool = False) -> dict:
        d = self.describe(env)
        info = self.inspect(env)
        if not info.get("found"):
            return dict(d, available=False, code="PROVIDER_NOT_FOUND",
                        reason="codex was not found on the login PATH (install: npm install -g @openai/codex).")
        if info.get("error"):
            return dict(d, available=False, executable=info["path"], reason=info["error"])
        if info["missingFlags"]:
            return dict(d, available=False, executable=info["path"], code="CAPABILITY_GAP",
                        reason=f"codex {info['version']} lacks required exec flags: {', '.join(info['missingFlags'])}.")
        login = self.login_status(env)
        if not login["loggedIn"]:
            return dict(d, available=False, executable=info["path"], code="AUTH_REQUIRED",
                        reason="codex is not logged in (run: codex login).")
        out = dict(d, available=True, executable=info["path"], login=login, authVerified=False)
        cached = self._cached_deep(info)
        if deep:
            cached = self._deep_probe(info, env)
        if cached:
            out.update(authVerified=cached.get("ok", False), deepProbe=cached)
            if not cached.get("ok"):
                out.update(available=False, code="AUTH_REQUIRED",
                           reason=f"codex could not complete a read-only micro-task: {cached.get('detail')}")
        return out

    def _cache_path(self) -> Optional[str]:
        from ... import paths
        try:
            return os.path.join(paths.ensure_state_dir(), "provider-probes.json")
        except AsError:
            return None

    def _cached_deep(self, info: dict) -> Optional[dict]:
        path = self._cache_path()
        try:
            with open(path, encoding="utf-8") as f:
                entry = json.load(f).get(f"codex:{info['path']}:{info['version']}")
        except (OSError, ValueError, TypeError):
            return None
        if entry and time.time() - entry.get("at", 0) < DEEP_PROBE_TTL_S:
            return entry
        return None

    def _deep_probe(self, info: dict, env: dict) -> dict:
        ws = tempfile.mkdtemp(prefix="agent-studio-codex-probe-")
        prompt = os.path.join(ws, ".prompt")
        with open(prompt, "w", encoding="utf-8") as f:
            f.write(f"Reply with exactly {PROBE_TOKEN} and nothing else. Do not run commands or edit files.")
        inp = AssignmentInput(assignment_id="00000000-0000-4000-8000-000000000000",
                              agent_id="00000000-0000-4000-8000-000000000000", provider_id="codex", attempt=1,
                              workspace=ws, prompt_path=prompt, role_instructions="", policy="read_only",
                              deadline_s=180, output_budget_bytes=1 << 20)
        prep = self.prepare(inp, env)
        st = ParseState()
        started = time.time()
        try:
            with open(prompt, "rb") as stdin:
                p = subprocess.run(prep.argv, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   cwd=ws, env=prep.environment(env), timeout=180)
            for line in p.stdout.splitlines():
                self.parse_line(line, st)
            ok = bool(st.terminal and st.terminal.get("ok")) and PROBE_TOKEN in (st.final_text or "")
            detail = "ok" if ok else _short((st.terminal or {}).get("summary") or p.stderr.decode("utf-8", "replace"))
        except subprocess.TimeoutExpired:
            ok, detail = False, "timed out after 180s (network or authentication problem?)"
        entry = {"ok": ok, "detail": detail, "at": time.time(), "seconds": round(time.time() - started, 1)}
        path = self._cache_path()
        if path:
            try:
                with open(path, encoding="utf-8") as f:
                    cache = json.load(f)
            except (OSError, ValueError):
                cache = {}
            cache[f"codex:{info['path']}:{info['version']}"] = entry
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(cache, f)
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        return entry

    # ---- execution ----------------------------------------------------------------------------
    def _prepare(self, inp: AssignmentInput, env: dict) -> Prepared:
        exe = self.executable(env)
        if not exe:
            raise AsError("PROVIDER_UNAVAILABLE", "codex was not found on the login PATH.")
        self.validate_settings(inp.model, inp.reasoning)
        argv = [exe, "exec", "--json", "--color", "never", "--ephemeral", "--skip-git-repo-check",
                "--cd", inp.workspace] + POLICY_FLAGS[inp.policy]
        if inp.model:
            argv += ["--model", inp.model]
        if inp.reasoning:
            argv += ["-c", f'model_reasoning_effort="{inp.reasoning}"']
        argv.append("-")  # the prompt comes from stdin (the private prompt file), never the command line
        assert not any(a in NEVER for a in argv)
        return Prepared(argv=argv, env_allowlist=ENV, stdin_path=inp.prompt_path, cwd=inp.workspace)

    def parse_line(self, line: bytes, state: ParseState):
        state.events += 1
        try:
            ev = json.loads(line.decode("utf-8"))
            if not isinstance(ev, dict):
                raise ValueError
        except UnicodeDecodeError:
            state.malformed += 1
            return [("attention", "codex output line is not UTF-8")]
        except ValueError:
            text = line.decode("utf-8", "replace").strip()
            if text.startswith("{"):
                state.malformed += 1
                return [("attention", "unparseable codex output line")]
            return [("progress", _short(text))] if text else []
        t = ev.get("type")
        if t is None and isinstance(ev.get("msg"), dict):  # older codex exec JSON format
            return self._legacy(ev["msg"], state)
        if t == "thread.started":
            state.session_id = str(ev.get("thread_id", ""))[:100] or None
            return [("progress", f"codex thread {state.session_id}")]
        if t == "turn.started":
            return [("progress", "turn started")]
        if t in ("item.started", "item.updated", "item.completed"):
            return self._item(t, ev.get("item") or {}, state)
        if t == "turn.completed":
            usage = ev.get("usage") if isinstance(ev.get("usage"), dict) else {}
            state.usage = {k: v for k, v in usage.items() if isinstance(v, int)}
            state.terminal = {"ok": True, "summary": (state.final_text or "codex finished the turn")[:2000]}
            return [("progress", "turn completed")]
        if t == "turn.failed":
            err = ev.get("error") or {}
            msg = err.get("message") if isinstance(err, dict) else str(err)
            state.terminal = {"ok": False, "summary": _short(msg or "turn failed", 2000), "code": "PROVIDER_ERROR"}
            return [("attention", f"turn failed: {_short(msg or '')}")]
        if t == "error":  # not terminal: codex also reports reconnect attempts this way
            return [("attention", _short(ev.get("message", "error")))]
        return []

    def _item(self, t: str, item: dict, state: ParseState):
        kind = item.get("type")
        done = t == "item.completed"
        if kind == "agent_message":
            if done and isinstance(item.get("text"), str):
                state.final_text = item["text"]
                return [("progress", "message: " + _short(item["text"], 200))]
            return []
        if kind == "reasoning":
            return [("progress", "thinking: " + _short(item.get("text", ""), 160))] if done else []
        if kind == "command_execution":
            cmd = _short(item.get("command", ""), 200)
            if t == "item.started":
                return [("progress", f"$ {cmd}")]
            if done:
                status = item.get("status")
                if status == "declined":
                    state.denials.append(f"command: {cmd}")
                    return [("attention", f"command declined: {cmd}")]
                return [("progress", f"$ {cmd} -> exit {item.get('exit_code')}")]
            return []
        if kind == "file_change" and done:
            changes = item.get("changes") or []
            names = ", ".join(f"{c.get('kind', '?')} {c.get('path', '?')}" for c in changes if isinstance(c, dict))
            if item.get("status") == "failed":
                return [("attention", f"file change failed: {_short(names, 200)}")]
            return [("progress", f"files: {_short(names, 200)}")]
        if kind == "mcp_tool_call" and done:
            return [("progress", f"tool {item.get('server', '?')}.{item.get('tool', '?')}: {item.get('status')}")]
        if kind == "web_search" and done:
            return [("progress", f"web search: {_short(item.get('query', ''), 160)}")]
        if kind == "todo_list" and t != "item.started":
            items = item.get("items") or []
            n = sum(1 for x in items if isinstance(x, dict) and x.get("completed"))
            return [("progress", f"plan: {n}/{len(items)} done")]
        if kind == "error" and done:
            return [("attention", _short(item.get("message", "error")))]
        return []

    def _legacy(self, msg: dict, state: ParseState):
        t = msg.get("type")
        if t == "session_configured":
            state.session_id = str(msg.get("session_id", ""))[:100] or None
        elif t == "agent_message":
            state.final_text = msg.get("message")
            return [("progress", "message: " + _short(msg.get("message", ""), 200))]
        elif t == "exec_command_begin":
            return [("progress", "$ " + _short(" ".join(msg.get("command") or []), 200))]
        elif t == "task_complete":
            state.final_text = msg.get("last_agent_message") or state.final_text
            state.terminal = {"ok": True, "summary": (state.final_text or "codex finished")[:2000]}
        elif t == "error":
            state.terminal = {"ok": False, "summary": _short(msg.get("message", "error"), 2000), "code": "PROVIDER_ERROR"}
            return [("attention", _short(msg.get("message", "error")))]
        return []
