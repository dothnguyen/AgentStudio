#!/usr/bin/env python3
"""Read-only snapshot of one board ticket's run, for debugging a ticket that looks stuck.

Usage (inside WSL):  python3 scripts/diagnose_ticket.py T-089 [--workspace PATH] [--out FILE]
Opens ~/.local/state/agent-studio/state.db read-only and writes a plain-text report (default:
diag-<KEY>.txt in the workspace; --out - prints it). Nothing is changed.
"""
import argparse
import json
import os
import sqlite3
import sys
import time


def main():
    p = argparse.ArgumentParser()
    p.add_argument("key")
    p.add_argument("--workspace", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    p.add_argument("--out")
    a = p.parse_args()
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    sd = os.path.join(base, "agent-studio")
    out_path = a.out or os.path.join(a.workspace, f"diag-{a.key}.txt")
    lines = []
    say = lines.append
    say(f"generated {time.strftime('%Y-%m-%d %H:%M:%S %z')}  state dir {sd}")
    conn = sqlite3.connect(f"file:{os.path.join(sd, 'state.db')}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    q = lambda sql, *args: [dict(r) for r in conn.execute(sql, args).fetchall()]
    say("schema version: " + str(q("SELECT MAX(version) AS v FROM schema_migrations")[0]["v"]))
    tickets = q("SELECT * FROM tickets WHERE key = ? ORDER BY updated_at DESC", a.key)
    if not tickets:
        say(f"no ticket {a.key}")
    for t in tickets:
        say("\n== TICKET")
        say(json.dumps({k: t[k] for k in ("key", "workspace", "status", "assignee", "active_run_id", "run_id",
                                          "lease_until", "worktree_path", "branch", "updated_at", "rounds_json",
                                          "blocked_reason")}, indent=1, default=str))
        if t["assignee"]:
            say("\n== ASSIGNEE AGENT")
            for g in q("SELECT id, display_name, member_id, role, provider_id, availability, pane_state, "
                       "pending_agent, active_catalog_agent, limit_reset_at, updated_at FROM agents WHERE id = ?",
                       t["assignee"]):
                say(json.dumps(g, indent=1, default=str))
        say("\n== TICKET EVENTS (last 25)")
        for e in q("SELECT at, actor, name, from_status, to_status, payload_json FROM ticket_events WHERE ticket_id = ? "
                   "ORDER BY id DESC LIMIT 25", t["id"])[::-1]:
            say(f"{e['at']} {e['actor']} {e['name']} {e['from_status']}->{e['to_status']} {e['payload_json'][:400]}")
        runs = [r for r in {t["active_run_id"], t["run_id"]} if r]
        for run in runs:
            for w in q("SELECT * FROM workflow_runs WHERE id = ?", run):
                say(f"\n== WORKFLOW RUN {run}")
                say(json.dumps({k: w[k] for k in ("status", "current_stage", "current_agent_id", "transition_reason",
                                                  "definition_name", "step_count", "deadline_at", "created_at",
                                                  "updated_at")}, indent=1, default=str))
                say("\n-- stage attempts")
                for s in q("SELECT id, stage, visit, attempt, status, phase, outcome, assignment_id, created_at, "
                           "updated_at, validation_json FROM stage_attempts WHERE workflow_run_id = ? ORDER BY rowid", run):
                    s["validation_json"] = (s["validation_json"] or "")[:300]
                    say(json.dumps(s, default=str))
                say("\n-- assignments")
                for x in q("SELECT id, agent_id, status, diagnostic_code, policy, provider_id, process_pid, created_at, "
                           "updated_at, result_json FROM assignments WHERE task_id = ? ORDER BY rowid", w["task_id"]):
                    res = json.loads(x.pop("result_json") or "null") or {}
                    x["summary"] = str(res.get("summary") or "")[:500]
                    x["attention"] = res.get("attention")
                    say(json.dumps(x, default=str))
                    rd = os.path.join(sd, "runs", x["id"])
                    for name in ("stderr.log", "stdout.jsonl"):
                        path = os.path.join(rd, name)
                        if os.path.exists(path):
                            with open(path, "rb") as f:
                                f.seek(0, 2)
                                size = f.tell()
                                f.seek(max(0, size - 1500))
                                say(f"   {name} ({size} bytes, modified {time.ctime(os.path.getmtime(path))}) tail:")
                                say("   " + f.read().decode("utf-8", "replace").replace("\n", "\n   "))
                try:
                    say("\n-- command requests")
                    for c in q("SELECT id, stage, visit, command_id, status, source, reason, process_json, result_json, "
                               "created_at, updated_at FROM command_requests WHERE workflow_run_id = ? ORDER BY ordinal", run):
                        say(json.dumps(c, default=str)[:1500])
                except sqlite3.Error as e:
                    say(f"(no command_requests table: {e})")
                say("\n-- run events (last 40)")
                for e in q("SELECT at, name, entity, from_state, to_state, payload_json FROM events WHERE workflow_run_id = ? "
                           "OR task_id = ? ORDER BY seq DESC LIMIT 40", run, w["task_id"])[::-1]:
                    say(f"{e['at']} {e['entity']} {e['name']} {e['from_state']}->{e['to_state']} {e['payload_json'][:300]}")
    log = os.path.join(sd, "coordinator.log")
    if os.path.exists(log):
        with open(log, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 12000))
            say(f"\n== COORDINATOR LOG tail ({size} bytes)")
            say(f.read().decode("utf-8", "replace"))
    pid = os.path.join(sd, "coordinator.pid.json")
    for name in os.listdir(sd):
        if name.endswith(".json") and "pid" in name:
            with open(os.path.join(sd, name)) as f:
                say(f"\n== {name}\n{f.read()[:500]}")
    if a.out in ("-", "/dev/stdout"):
        sys.stdout.write("\n".join(lines) + "\n")
        return 0
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    sys.exit(main())
