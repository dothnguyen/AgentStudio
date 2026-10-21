"""tmux control on Agent Studio's own server socket (`tmux -L agent-studio`).

Agent Studio never touches the user's default tmux server, never uses pane indices as identity, never sends
keystrokes, and never runs kill-server. Every target is a tmux ID ($session, @window, %pane) we recorded.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from typing import Dict, List, Optional

from .protocol import AsError

TMUX_FAILED = "TMUX_FAILED"
DEFAULT_SOCKET = "agent-studio"
SOCKET_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
TMUX_ID_RE = {"session": re.compile(r"^\$[0-9]+$"), "window": re.compile(r"^@[0-9]+$"), "pane": re.compile(r"^%[0-9]+$")}
SESSION_NAME_RE = re.compile(r"^as-[0-9a-f]{16}$")
OPT_TEAM = "@agent_studio_team"
OPT_OWNER = "@agent_studio_owner"
PANE_FORMAT = "#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}"


def socket_name() -> str:
    name = os.environ.get("AGENT_STUDIO_TMUX_SOCKET", DEFAULT_SOCKET)
    if not SOCKET_RE.match(name):
        raise AsError(TMUX_FAILED, "AGENT_STUDIO_TMUX_SOCKET may only contain letters, digits, '.', '_' and '-'.")
    return name


def session_name_for(team_id: str) -> str:
    return "as-" + team_id.replace("-", "")[:16]


def check_id(kind: str, value: str) -> str:
    if not isinstance(value, str) or not TMUX_ID_RE[kind].match(value):
        raise AsError(TMUX_FAILED, f"Refusing to target malformed tmux {kind} id {value!r}.")
    return value


class Tmux:
    def __init__(self, path: Optional[str] = None, socket: Optional[str] = None, env: Optional[dict] = None):
        self.env = dict(env if env is not None else os.environ)
        for k in ("TMUX", "TMUX_PANE"):  # never act on whatever tmux the caller happens to be inside
            self.env.pop(k, None)
        self.path = path or shutil.which("tmux", path=self.env.get("PATH", "")) or "/usr/bin/tmux"
        self.socket = socket or socket_name()

    def base(self) -> List[str]:
        return [self.path, "-L", self.socket]

    def run(self, *args: str, check: bool = True, timeout: float = 10) -> subprocess.CompletedProcess:
        try:
            proc = subprocess.run(self.base() + list(args), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, env=self.env, timeout=timeout)
        except (OSError, subprocess.SubprocessError) as e:
            raise AsError(TMUX_FAILED, f"tmux could not be run: {e}")
        if check and proc.returncode != 0:
            raise AsError(TMUX_FAILED, f"tmux {args[0]} failed: {proc.stderr.decode('utf-8', 'replace').strip()}")
        return proc

    def out(self, *args: str) -> str:
        return self.run(*args).stdout.decode("utf-8", "replace")

    # ---- inventory --------------------------------------------------------------------------------
    def list_panes(self) -> Optional[List[Dict[str, str]]]:
        """All panes on our server, or None when the server is not running."""
        proc = self.run("list-panes", "-a", "-F", PANE_FORMAT, check=False)
        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", "replace")
            if "no server running" in err or "error connecting" in err or "No such file" in err:
                return None
            raise AsError(TMUX_FAILED, f"tmux list-panes failed: {err.strip()}")
        panes = []
        for line in proc.stdout.decode("utf-8", "replace").splitlines():
            parts = line.split("\t")
            if len(parts) == 5:
                panes.append({"session_id": parts[0], "window_id": parts[1], "pane_id": parts[2],
                              "pane_pid": int(parts[3]) if parts[3].isdigit() else None, "dead": parts[4] == "1"})
        return panes

    def list_sessions(self) -> Optional[List[Dict[str, str]]]:
        proc = self.run("list-sessions", "-F", "#{session_id}\t#{session_name}", check=False)
        if proc.returncode != 0:
            return None
        rows = []
        for line in proc.stdout.decode("utf-8", "replace").splitlines():
            sid, _, name = line.partition("\t")
            rows.append({"session_id": sid, "session_name": name})
        return rows

    def session_option(self, session_id: str, option: str) -> Optional[str]:
        check_id("session", session_id)
        proc = self.run("show-options", "-t", session_id, "-v", option, check=False)
        if proc.returncode != 0:
            return None
        return proc.stdout.decode("utf-8", "replace").strip() or None

    def session_exists(self, session_id: str) -> bool:
        check_id("session", session_id)
        sessions = self.list_sessions()
        return bool(sessions) and any(s["session_id"] == session_id for s in sessions)

    # ---- creation -----------------------------------------------------------------------------
    def create_team_session(self, name: str, workspace: str, commands: List[str], titles: List[str],
                            team_id: str, owner_marker: str) -> dict:
        """One session, one window, exactly len(commands) panes in tiled layout. Returns recorded tmux IDs.
        On any failure the half-built session is killed (we created it, so we own it) and TMUX_FAILED raised."""
        if not SESSION_NAME_RE.match(name):
            raise AsError(TMUX_FAILED, f"Invalid session name {name!r}.")
        if not commands:
            raise AsError(TMUX_FAILED, "A team needs at least one pane.")
        if self.session_by_name(name):
            raise AsError(TMUX_FAILED, f"A tmux session named {name} already exists on socket {self.socket}.")
        first = self.out("new-session", "-d", "-P", "-F", "#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}",
                         "-s", name, "-n", "agents", "-x", "240", "-y", "64", "-c", workspace, commands[0]).strip()
        session_id, window_id, pane_id, pane_pid = first.split("\t")
        try:
            check_id("session", session_id)
            check_id("window", window_id)
            self.out("set-option", "-t", session_id, OPT_TEAM, team_id)
            self.out("set-option", "-t", session_id, OPT_OWNER, owner_marker)
            self.out("set-window-option", "-t", window_id, "remain-on-exit", "on")
            self.out("set-window-option", "-t", window_id, "pane-border-status", "top")
            self.out("set-window-option", "-t", window_id, "pane-border-format", " #{pane_title} ")
            panes = [(pane_id, int(pane_pid))]
            for cmd in commands[1:]:
                line = self.out("split-window", "-d", "-P", "-F", "#{pane_id}\t#{pane_pid}", "-t", window_id,
                                "-c", workspace, cmd).strip()
                pid_, _, ppid = line.partition("\t")
                panes.append((pid_, int(ppid)))
                self.out("select-layout", "-t", window_id, "tiled")
            self.out("select-layout", "-t", window_id, "tiled")
            for (pid_, _), title in zip(panes, titles):
                self.out("select-pane", "-t", pid_, "-T", title)
            observed = [p for p in (self.list_panes() or []) if p["window_id"] == window_id]
            windows = {p["window_id"] for p in (self.list_panes() or []) if p["session_id"] == session_id}
            if len(observed) != len(commands) or windows != {window_id}:
                raise AsError(TMUX_FAILED, f"Expected {len(commands)} panes in one window, found {len(observed)} "
                                           f"pane(s) in {len(windows)} window(s).")
            if [p["pane_id"] for p in sorted(observed, key=lambda p: int(p["pane_id"][1:]))] != \
                    sorted((p for p, _ in panes), key=lambda p: int(p[1:])):
                raise AsError(TMUX_FAILED, "Observed pane IDs do not match the panes that were created.")
            return {"session_id": session_id, "session_name": name, "window_id": window_id,
                    "panes": [{"pane_id": p, "pane_pid": pid} for p, pid in panes]}
        except BaseException:
            self.run("kill-session", "-t", session_id, check=False)
            raise

    def session_by_name(self, name: str) -> Optional[str]:
        for s in self.list_sessions() or []:
            if s["session_name"] == name:
                return s["session_id"]
        return None

    def kill_session(self, session_id: str) -> None:
        check_id("session", session_id)
        self.run("kill-session", "-t", session_id)

    def attach_argv(self, session_name: str) -> List[str]:
        if not SESSION_NAME_RE.match(session_name):
            raise AsError(TMUX_FAILED, f"Invalid session name {session_name!r}.")
        return self.base() + ["attach-session", "-t", "=" + session_name]
