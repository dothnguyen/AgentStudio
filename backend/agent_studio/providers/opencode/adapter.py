"""OpenCode adapter (P00-S11). Verified against the installed opencode v2.1.4 (`--version`, `run --help`,
`auth list`, real `run --format json` output — error events only, see CONTRACT.md for the recorded gap).
Nothing here guesses a flag: the installed CLI's help is checked for every flag we use.

The CLI is real and headless-capable, but v2.1.4 has no mechanism to inject a run-scoped permission
configuration (no `--config` flag; `OPENCODE_CONFIG` and `XDG_CONFIG_HOME` are not consulted by the config
loader — verified empirically), so Agent Studio cannot prove `read_only` / `workspace_write` enforcement.
Both policies therefore stay `unsupported` and `probe` reports `CAPABILITY_GAP`: preflight and `team.start`
refuse this provider instead of running it with unverified permissions. Everything else in this adapter is
implemented and tested so that implementing the policy mapping (CONTRACT.md, "Policy design") unblocks it.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from typing import Dict, List, Optional

from ...protocol import AsError
from .. import cli_support
from ..base import BASE_ENV, POLICIES, UNSUPPORTED, Adapter, AssignmentInput, ParseState, Prepared

REQUIRED_FLAGS = ("--format", "--model", "--agent", "--session", "--standalone", "--log-level")
# `--auto` auto-approves every permission that is not explicitly denied: the bypass analog. `--continue` /
# `--session` reuse another session; the runner never resumes.
NEVER = ("--auto", "--continue", "-c")
ENV = BASE_ENV + ("OPENCODE_CONFIG", "OPENCODE_API_KEY", "OPENCODE_BASE_URL", "OPENCODE_LOG_LEVEL",
                  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
                  "SSL_CERT_FILE", "SSL_CERT_DIR")
_inspect_cache: Dict[tuple, dict] = {}


def _short(text: str, n: int = 300) -> str:
    return " ".join(str(text).split())[:n]


def _install_fallback() -> str:
    return os.path.join(os.path.expanduser("~"), ".opencode", "bin", "opencode")


class OpenCodeAdapter(Adapter):
    provider_id = "opencode"

    # ---- declaration -------------------------------------------------------------------------
    def capabilities(self) -> dict:
        return {"headless": True, "structuredProgress": True, "structuredFinal": True, "resume": UNSUPPORTED,
                "interactiveInput": UNSUPPORTED}

    def policy_mapping(self) -> Dict[str, Optional[List[str]]]:
        # Both refused (CONTRACT.md, "Policy design"): v2.1.4 reads its permission rules only from the
        # project/global/system config directories, none of which Agent Studio can scope to one run
        # without either letting the agent edit its own permissions or changing the user's global config.
        return {p: None for p in POLICIES}

    def reasoning_levels(self):
        # `run --help` has no reasoning flag; model variants (`--model provider/model#variant`) are
        # model-specific and unverified. Refuse reasoning until a variant scheme is verified.
        return ()

    def model_selectable(self) -> bool:
        return True  # verified: `--model, -m string   Model to use in the format provider/model#variant`

    def supports_deep_probe(self) -> bool:
        return False  # no model is runnable with the recorded subscription gap; no micro-task possible

    # ---- installed CLI ------------------------------------------------------------------------
    def executable(self, env: dict) -> Optional[str]:
        found = shutil.which("opencode", path=env.get("PATH", ""))
        if found:
            return found
        fallback = _install_fallback()  # the installer's default location; not on the login PATH by default
        return fallback if os.path.isfile(fallback) and os.access(fallback, os.X_OK) else None

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
        info = {"found": True, "path": exe, "version": m.group(1) if m else version_text[:60],
                "versionText": version_text[:120],
                "missingFlags": [f for f in REQUIRED_FLAGS if f not in help_text]}
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
        # verified v2.1.4 output: one line per credential, "<name>  <name>  stored"
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
                        reason=f"opencode {info['version']} lacks required run flags: "
                               f"{', '.join(info['missingFlags'])}.")
        login = self.login_status(env)
        if not login["loggedIn"]:
            return dict(d, available=False, executable=info["path"], code="AUTH_REQUIRED",
                        reason="opencode has no stored credential (run: opencode auth login).")
        mapping = self.policy_mapping()
        if any(mapping.get(p) is None for p in POLICIES):
            return dict(d, available=False, executable=info["path"], code="CAPABILITY_GAP",
                        reason=f"opencode {info['version']} has no run-scoped permission configuration Agent "
                               f"Studio can inject (verified: no --config flag; OPENCODE_CONFIG and "
                               f"XDG_CONFIG_HOME are not consulted by the config loader), so read_only and "
                               f"workspace_write cannot be proven. See providers/opencode/CONTRACT.md.",
                        login=login)
        out = dict(d, available=True, executable=info["path"], login=login)
        return cli_support.apply_deep(out, self, info, env, deep)

    # ---- execution ----------------------------------------------------------------------------
    def _prepare(self, inp: AssignmentInput, env: dict) -> Prepared:
        exe = self.executable(env)
        if not exe:
            raise AsError("PROVIDER_UNAVAILABLE", "opencode was not found on the login PATH.")
        self.validate_settings(inp.model, inp.reasoning)
        policy_flags = self.policy_mapping().get(inp.policy)
        if policy_flags is None:
            raise AsError("POLICY_UNSUPPORTED", f"opencode has no verified mapping for {inp.policy}.")
        # `--standalone`: a private server per run instead of the shared background service — the service
        # pins its config at start, and Agent Studio never touches a server it did not create.
        argv = [exe, "run", "--standalone", "--format", "json", "--log-level", "none"] + policy_flags
        if any(a in NEVER for a in argv):
            raise AsError("BAD_ADAPTER", "refusing an auto-approval or session-reuse flag")
        if inp.model:
            argv += ["--model", inp.model]
        # no message argument: the prompt comes from stdin (the private prompt file), never the command line
        return Prepared(argv=argv, env_allowlist=ENV, stdin_path=inp.prompt_path, cwd=inp.workspace)

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
        t = ev.get("type")
        if t == "step_start":
            state.session_id = str(ev.get("sessionID", ""))[:100] or None
            return [("progress", f"opencode session {state.session_id}")]
        if t == "error":
            # verified: the CLI exits 0 even on a provider error, so the error event is the only
            # authoritative failure signal. Terminal: the run produced no reply.
            err = ev.get("error") or {}
            kind = err.get("type") if isinstance(err, dict) else str(err)
            msg = err.get("message") if isinstance(err, dict) else str(err)
            code = "AUTH_REQUIRED" if kind == "provider.auth" else "PROVIDER_ERROR"
            state.terminal = {"ok": False, "code": code,
                              "summary": _short(msg or f"opencode error ({kind})", 2000)}
            return [("attention", f"error ({kind}): {_short(msg or '', 200)}")]
        part = ev.get("part") if isinstance(ev.get("part"), dict) else None
        if part is not None:  # part events carry the message content (documented; see CONTRACT.md)
            return self._part(part, state)
        return []

    def _part(self, part: dict, state: ParseState):
        kind = part.get("type")
        if kind == "text" and isinstance(part.get("text"), str):
            state.final_text = part["text"]
            return [("progress", "message: " + _short(part["text"], 200))]
        if kind == "step-finish":
            state.terminal = {"ok": True, "summary": (state.final_text or "opencode finished")[:2000]}
            usage = part.get("tokens") if isinstance(part.get("tokens"), dict) else {}
            state.usage = {k: v for k, v in usage.items() if isinstance(v, int) and not isinstance(v, bool)}
            return [("progress", "step finished")]
        if kind == "tool" and isinstance(part.get("tool"), str):
            state_name = part.get("state")
            if state_name == "error":
                return [("attention", f"tool {part['tool']}: {_short(str(part.get('error', '')), 160)}")]
            return [("progress", f"tool {part['tool']} {state_name or ''}".rstrip())]
        return []
