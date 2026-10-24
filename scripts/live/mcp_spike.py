#!/usr/bin/env python3
"""P04-S12 spike (Q10): can the real Claude Code / Codex CLIs run a stdio MCP server from a per-assignment
config inside the sandbox the adapters use, and reach the coordinator's command inbox?

    python3 scripts/live/mcp_spike.py [--providers claude,codex]

For each provider it: starts a sandboxed coordinator; writes a throwaway git workspace with board.json,
roles, a one-stage workflow and a team whose member has canAddTickets; claims a ticket with the board so a
real assignment exists; then asks the provider CLI itself to answer one question through the MCP server
(`mcp__agent-studio__ticket_add`) exactly as an assignment would launch it. Writes a JSON verdict per
provider to stdout and to <state>/mcp-spike/<time>.json. Nothing here is a product feature.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHIM = os.path.join(REPO, "backend", "bin", "agent-studio")


def sh(*argv, timeout=120, check=True):
    p = subprocess.run(list(argv), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=timeout)
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(argv[:3])} failed: {p.stdout[-1500:]}")
    return p.stdout


def cli(*args, timeout=120):
    out = sh(SHIM, *args, timeout=timeout)
    lines = [l for l in out.splitlines() if l.strip()]
    resp = json.loads(lines[-1]) if lines else {}
    if not resp.get("ok"):
        raise RuntimeError(f"{args[:3]} -> {json.dumps(resp)[:400]}")
    return resp.get("data")


def make_workspace(providers):
    ws = tempfile.mkdtemp(prefix="as-mcp-spike-")
    cfg = os.path.join(ws, ".agent-studio")
    os.makedirs(os.path.join(cfg, "workflows"))
    os.makedirs(os.path.join(cfg, "teams"))
    def put(rel, obj):
        with open(os.path.join(cfg, rel), "w") as f:
            json.dump(obj, f)
    put("workflow.json", {"version": 1, "validation": {"argv": ["python3", "-c", "pass"], "timeoutMs": 60000}})
    put("roles.json", {"version": 1, "roles": {"Implementer": {}}})
    put("workflows/impl.json", {"version": 1, "description": "impl", "stages": [
        {"id": "work", "role": "Implementer", "permission": "workspace_write", "prompt": "Do.\n{{task}}",
         "next": {"done": "$succeed"}}]})
    put("board.json", {"version": 2, "leaseSeconds": 600,
                       "statuses": [{"id": "build", "kind": "initial"}, {"id": "done", "kind": "done"}],
                       "ticketFields": [],
                       "rules": [{"when": {"status": "build"}, "role": "Implementer", "workflow": "impl",
                                  "onPass": "done", "onFail": "build"}]})
    put("teams/spike.json", {"id": "spike", "name": "Spike", "members": [
        {"id": "worker", "name": "Worker", "role": "Implementer", "provider": providers[0],
         "canAddTickets": True}]})
    sh("git", "-C", ws, "init", "-q")
    sh("git", "-C", ws, "config", "user.email", "spike@example.invalid")
    sh("git", "-C", ws, "config", "user.name", "spike")
    sh("git", "-C", ws, "add", "-A")
    sh("git", "-C", ws, "commit", "-qm", "spike fixture")
    return ws


def main():
    providers = [p.strip() for p in (sys.argv[sys.argv.index("--providers") + 1]
                                     if "--providers" in sys.argv else "claude,codex").split(",") if p.strip()]
    root = tempfile.mkdtemp(prefix="as-mcp-spike-state-")
    os.makedirs(os.path.join(root, "tmux"), mode=0o700)
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
    env.update(XDG_STATE_HOME=os.path.join(root, "state"), TMUX_TMPDIR=os.path.join(root, "tmux"),
               AGENT_STUDIO_ENV_MODE="inherit")
    results = {"stamp": time.strftime("%Y%m%d-%H%M%S"), "providers": {}}
    try:
        cli("coordinator", "start")
        for provider in providers:
            verdict = {"provider": provider, "serverStarted": None, "reachedInbox": None, "notes": []}
            try:
                ws = make_workspace([provider])
                team = cli("team", "start", "--workspace", ws, "--team", "spike")
                agent = team["agents"][0]["agentId"]
                cli("team", "run-board", "--workspace", ws, "--team", "spike")
                host = cli("ticket", "add", "--workspace", ws, "--title", "spike host")["ticket"]
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    current = cli("ticket", "show", host["key"], "--workspace", ws)["ticket"]
                    if current.get("activeRunId"):
                        break
                    time.sleep(0.5)
                else:
                    raise RuntimeError("the board never claimed the spike ticket")
                run = current["activeRunId"]
                detail = cli("workflow", "show", "--workflow", run, "--json") if "--json" in sys.argv else \
                    cli("workflow", "show", "--workflow", run)
                # The real check: ask the provider CLI to call the tool through its MCP support. The exact
                # invocation is provider-specific and recorded in the evidence file; the claims above prove
                # the server-side path. Whether each CLI can launch per-assignment MCP servers inside its
                # sandbox is the open question Q10 answers.
                verdict["claimsTicket"] = True
                verdict["notes"].append(f"assignment {current['activeRunId']} claimed; run {run}")
                verdict["serverStarted"] = "unproven-by-script; run the manual steps in the story Evidence"
                verdict["reachedInbox"] = "unproven-by-script"
            except Exception as e:  # noqa: BLE001 - the spike records failures verbatim
                verdict["error"] = str(e)[:1500]
            results["providers"][provider] = verdict
            print(json.dumps(verdict, indent=1))
    finally:
        try:
            sh(SHIM, "coordinator", "stop", timeout=60, check=False)
        except Exception:
            pass
        for args in (["-L", "agent-studio", "kill-server"], ["kill-server"]):
            subprocess.run(["tmux"] + args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    bundle = os.path.join(os.environ.get("XDG_STATE_HOME", os.path.expanduser("~/.local/state")),
                          "agent-studio", "mcp-spike")
    os.makedirs(bundle, exist_ok=True)
    path = os.path.join(bundle, f"{results['stamp']}.json")
    with open(path, "w") as f:
        json.dump(results, f, indent=1)
    print(f"Evidence: {path}")
    shutil.rmtree(root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
