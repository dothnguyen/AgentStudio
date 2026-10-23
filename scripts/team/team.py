#!/usr/bin/env python3
"""Operator helper for running this project with an Agent Studio team (P00 features only).

It is glue on YOUR side of the CLI: it builds task texts, runs git and the unit tests in your shell (agents cannot
run commands), and remembers per-story state. Every agent action goes through the normal `agent-studio` CLI.

    team.py start                 start the team from .agent-studio/team.json and remember its IDs
    team.py attach                watch the three panes (Ctrl-b d to detach)
    team.py status                agents and recent work
    team.py unpack BRIEF --out DIR    product owner turns a feature brief into phases/epics/stories files
    team.py bug [TEXT] [--file PATH] [--attach PATH ...]
                                  create a triage bug ticket from text or a UTF-8 file
    team.py review STORY          team lead reviews a story before work (verdict pass = approved)
    team.py dev STORY             workflow: dev implements -> unit tests -> QA review -> one repair round
    team.py fix STORY             dev fixes the latest QA findings (after a failed workflow or QA round)
    team.py qa STORY              you run the unit tests here; QA reviews diff + results
    team.py final STORY           team lead final review + proposed commit message
    team.py commit STORY [--skip-integration]
                                  run the integration tests the change touched (parallel), then commit with the
                                  lead's message (asks first)
    team.py workflows             workflow definitions available here (built-in and .agent-studio/workflows)
    team.py check NAME            validate a definition against the saved team (no tokens spent)
    team.py run NAME (PROMPT | --story PATH | --prompt-file PATH) [--bind ROLE=NAME ...] [--no-wait]
                                  run a workflow definition; with --story it also records what `commit` needs
    team.py retry                 rerun the active workflow's stuck stage (waiting_input / paused by the engine)
    team.py index                 build the ctags symbol index agents search (.agent-studio/cache/tags)
    team.py blocked               agents held by a permission denial / unclear restart, and how to free them
    team.py resolve ROLE --action fail|retry|cancel   free that agent
    team.py stop                  stop the team

STORY is a path like phases/phase-01/stories/P01-S02-something.md (relative to the workspace).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

WS = subprocess.run(["git", "rev-parse", "--show-toplevel"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    text=True).stdout.strip() or os.getcwd()
STATE = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "agent-studio",
                     "project-team", re.sub(r"[^A-Za-z0-9]+", "_", WS).strip("_"))
import shutil
# The installed entry shim, even when ~/.local/bin is not on this terminal's PATH.
AS = (os.environ.get("AGENT_STUDIO") or shutil.which("agent-studio")
      or os.path.expanduser("~/.local/bin/agent-studio"))
if not os.access(AS, os.X_OK):
    sys.exit(f"agent-studio is not installed ({AS}). Run: bash ~/agent-studio-runtime/backend/install.sh")
LIMIT = 30 * 1024            # agent-studio accepts task text up to 32 KiB
DIFF_LIMIT, TEST_LIMIT = 16 * 1024, 5 * 1024


# ---- plumbing ---------------------------------------------------------------------------------------
def sh(*argv, check=True, cwd=WS):
    p = subprocess.run(list(argv), cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if check and p.returncode != 0:
        sys.exit(f"command failed: {' '.join(argv)}\n{p.stdout}")
    return p


def cli(*args, stdin=None):
    p = subprocess.run([AS] + list(args), input=stdin, stdout=subprocess.PIPE, text=True)
    lines = [l for l in p.stdout.splitlines() if l.strip()]
    try:
        resp = json.loads(lines[-1])
    except (IndexError, ValueError):
        sys.exit(f"agent-studio gave no JSON response (exit {p.returncode})")
    if not resp.get("ok"):
        err = resp.get("error") or {}
        if err.get("code") == "AGENT_BUSY" and "waiting_input" in (err.get("message") or ""):
            sys.exit(f"{err['message']}\n  The agent's previous task stopped on a permission denial and is waiting for "
                     f"your decision.\n  See it with:  team.py blocked     then:  team.py resolve <ROLE> --action fail")
        sys.exit(f"{err.get('code')}: {err.get('message')}" + (f"\n  -> {err['remediation']}" if err.get("remediation") else ""))
    return resp["data"]


def load(name, default=None):
    try:
        with open(os.path.join(STATE, name + ".json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(name, data):
    os.makedirs(STATE, exist_ok=True)
    with open(os.path.join(STATE, name + ".json"), "w") as f:
        json.dump(data, f, indent=2)


def team():
    t = load("team")
    if not t:
        sys.exit("No team recorded for this workspace. Run: team.py start")
    return t


def story_key(story):
    if not os.path.isfile(os.path.join(WS, story)):
        sys.exit(f"Story file not found in the workspace: {story}")
    return "story-" + re.sub(r"[^A-Za-z0-9]+", "_", os.path.splitext(os.path.basename(story))[0])


def clip(text, n):
    b = text.encode()
    return text if len(b) <= n else b[:n].decode(errors="ignore") + f"\n[... truncated, {len(b) - n} more bytes]"


def direct(agent, policy, text):
    """Run one direct task to completion, showing progress; return (status, summary)."""
    text = clip(text, LIMIT)
    print(f"--> {agent['name']} ({agent['role']}, {policy})", flush=True)
    d = cli("task", "direct", "--team", team()["teamId"], "--agent", agent["agentId"], "--policy", policy,
            "--text-file", "-", "--wait", stdin=text)
    a = d["assignments"][-1]
    res = a.get("result") or {}
    # finalText is the agent's whole last message (summary is cut at 2000 characters)
    return a["status"], res.get("finalText") or res.get("summary") or res.get("diagnosticCode") or ""


def verdict(text):
    for line in reversed((text or "").strip().splitlines()):
        line = line.strip().strip("`")
        if line.startswith("{") and '"verdict"' in line:
            try:
                return json.loads(line)
            except ValueError:
                pass
    return None


def diff_since(base):
    d = sh("git", "diff", base, check=False).stdout
    for f in sh("git", "ls-files", "--others", "--exclude-standard").stdout.split():
        d += sh("git", "diff", "--no-index", "--", "/dev/null", f, check=False).stdout
    return d


def changes_section(base):
    """The diff when it fits; otherwise the list of changed files, which the reviewer reads itself (it has the
    Read tool). Never a cut-off diff: a reviewer shown half the code reports the other half as missing."""
    diff = diff_since(base)
    changed = sh("git", "diff", "--name-status", base, check=False).stdout.strip().splitlines()
    changed += [f"A\t{f}" for f in sh("git", "ls-files", "--others", "--exclude-standard").stdout.split()]
    listing = "\n".join(changed) or "(no changes)"
    if len(diff.encode()) <= DIFF_LIMIT:
        return f"CHANGED FILES since {base[:12]}:\n{listing}\n\nDIFF:\n{diff or '(no changes)'}"
    return (f"CHANGED FILES since {base[:12]} (A = new, M = modified, D = deleted):\n{listing}\n\n"
            f"The full diff is {len(diff.encode()) // 1024} KiB, too large to include here. Read every changed "
            f"file listed above in full before judging; do not report anything as missing without reading the "
            f"file where it would be.")


def run_tests():
    cfg = json.load(open(os.path.join(WS, ".agent-studio", "workflow.json")))
    argv = cfg["validation"]["argv"]
    print(f"--> running {' '.join(argv)}", flush=True)
    p = subprocess.run(argv, cwd=WS, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                       timeout=cfg["validation"].get("timeoutMs", 180000) / 1000)
    return p.returncode == 0, " ".join(argv), p.stdout[-TEST_LIMIT:]


def show(title, body):
    print(f"\n===== {title} =====\n{body.strip()}\n", flush=True)


# ---- commands ---------------------------------------------------------------------------------------
def c_start(_):
    d = cli("team", "start", "--workspace", WS)
    agents = {a["role"]: {"agentId": a["agentId"], "name": a.get("displayName"), "role": a["role"],
                          "model": a.get("model")} for a in d["agents"]}
    for role in ("TeamLead", "Developer", "QA"):
        if role not in agents:
            sys.exit(f"team.json has no {role} agent")
    for a in d["agents"]:
        print(f"  {a['role']:9} {a.get('displayName'):12} {a.get('model') or 'default model':20} "
              f"role files: {'yes' if a.get('roleConfigured') else 'NO'} {a.get('roleWarnings') or ''}")
    save("team", {"teamId": d["teamId"], "agents": agents, "attach": d["attach"]["wsl"]})
    print(f"\nTeam {d['teamId']} started. Watch it with: python3 {sys.argv[0]} attach")


def c_attach(_):
    os.execvp(AS, [AS, "team", "attach", "--team", team()["teamId"]])


def c_status(_):
    d = cli("snapshot", "--team", team()["teamId"])
    for a in d.get("agents", []):
        print(f"  {a['role']:9} {a['availability']:14} {a.get('model') or ''}")
    for a in d.get("agents", []):
        if a["availability"] == "limit_reached":
            print(f"LIMIT: {a.get('displayName') or a['role']} ({a['providerId']}) until {a.get('limitResetAt') or 'unknown'}")
    for w in d.get("workflowRuns", [])[-3:]:
        print(f"  workflow {w['id'][:8]} {w['status']}")
    for a in d.get("assignments", [])[-6:]:
        print(f"  task {a['id'][:8]} {a['status']:10} {(a.get('result') or {}).get('summary', '')[:70]!r}")


def c_unpack(ns):
    brief = open(os.path.join(WS, ns.brief), encoding="utf-8").read()
    agents = team()["agents"]
    role = "ProductOwner" if "ProductOwner" in agents else "TeamLead"
    manifest = " Include tickets.json with the manifest schema from your role file." if role == "ProductOwner" else ""
    st, out = direct(agents[role], "workspace_write",
                     f"UNPACK this feature into phases -> epics -> stories. Write the plan into {ns.out}/ "
                     f"(a README.md overview plus one story file per story, following the story-format skill).{manifest} "
                     f"Read PRD.md, ROADMAP.md and the existing phases/ first.\n\nFEATURE BRIEF ({ns.brief}):\n{brief}")
    show(f"{role} ({st})", out)
    print(f"Review the files, answer the {role}'s open questions in the brief, and run unpack again to revise.\n"
          "Commit the plan before developing stories: git add -A && git commit -m 'Plan: ...'")


def changed_paths():
    out = sh("git", "status", "--porcelain", "--untracked-files=all").stdout.splitlines()
    return [l[3:].split(" -> ")[-1].strip('"') for l in out if l.strip()]


def c_review(ns):
    key = story_key(ns.story)
    before = set(changed_paths())
    st, out = direct(team()["agents"]["TeamLead"], "workspace_write",
                     f"REVIEW A STORY BEFORE WORK. Story file: {ns.story}. Read it and the documents it links. "
                     f"Fix what you can in the story (and, if a shared contract changes, the phase README and "
                     f"dependent stories), as your role instructions say.")
    v = verdict(out)
    approved = bool(v and v.get("verdict") == "pass")
    edited = sorted(set(changed_paths()) - before)
    save(key, dict(load(key, {}), story=ns.story, approved=approved, review=out))
    show(f"team lead review ({st})", out)
    if edited:
        planning = [p for p in edited if p.startswith(("phases/", "PRD.md", "ROADMAP.md"))]
        other = [p for p in edited if p not in planning]
        print("Files the team lead changed:\n  " + "\n  ".join(edited))
        if other:
            print("WARNING: changes outside the planning documents - check them before committing:\n  "
                  + "\n  ".join(other))
        if planning and input("Commit the planning changes now? [Y/n] ").strip().lower() in ("", "y", "yes"):
            sh("git", "add", "--", *planning)
            sh("git", "commit", "-q", "-m", f"Review {os.path.basename(ns.story)}: story updated by the team lead",
               "--", *planning)
            print("Committed.")
    print("APPROVED - next: team.py dev " + ns.story if approved else
          "NOT approved - answer the lead's questions (edit the story, or add them to the task), then review again.")


def c_dev(ns):
    key = story_key(ns.story)
    s = load(key, {})
    if not s.get("approved") and not ns.force:
        sys.exit("The team lead has not approved this story. Run: team.py review STORY (or pass --force).")
    if sh("git", "status", "--porcelain").stdout.strip():
        sys.exit("The workspace has uncommitted changes; commit or stash them first (the workflow needs a clean start).")
    base = sh("git", "rev-parse", "HEAD").stdout.strip()
    t = team()
    text = (f"Implement the story in {ns.story}. Read it first, follow its 'Implement in this order' steps, and make "
            f"every 'Done when' item true. Add unit tests in tests/unit for the new behaviour. Do not mark the story "
            f"Done and do not edit its Status line; the team lead does that after review.")
    print("--> workflow: dev implements -> unit tests -> QA review (-> one repair round)", flush=True)
    d = cli("workflow", "start", "--team", t["teamId"], "--developer", t["agents"]["Developer"]["agentId"],
            "--reviewer", t["agents"]["QA"]["agentId"], "--text-file", "-", "--wait", stdin=text)
    wf = d["workflowRun"]
    findings, last_val = [], None
    for sa in d.get("stageAttempts", []):
        if sa.get("verdict"):
            findings = sa["verdict"].get("findings") or []
        if sa.get("validation"):
            last_val = sa["validation"]
    save(key, dict(s, story=ns.story, base=base, workflow=wf["id"], findings=findings,
                   qaPassed=wf["status"] == "succeeded"))
    show(f"workflow {wf['id'][:8]}: {wf['status']}", "\n".join(f"- {f}" for f in findings) or "(no findings)")
    if last_val:
        print(f"last test run: {'passed' if last_val.get('passed') else 'FAILED'}")
    if wf["status"] == "succeeded":
        print("QA passed - next: team.py final " + ns.story)
    else:
        print("Not finished - the changes are still in the workspace. Loop with:\n"
              f"  team.py fix {ns.story}   then   team.py qa {ns.story}   (repeat until QA passes)")


def c_fix(ns):
    key = story_key(ns.story)
    s = load(key, {})
    if not s.get("base"):
        sys.exit("No development recorded for this story. Run: team.py dev STORY")
    blockers = [f for f in s.get("findings") or [] if not str(f).upper().startswith("SUGGESTION")]
    findings = "\n".join(f"- {f}" for f in blockers) or "(see the test output)"
    ok, cmd, out = run_tests()
    st, summary = direct(team()["agents"]["Developer"], "workspace_write",
                         f"Fix the QA blockers for the story in {ns.story}. Change only what they need; ignore suggestions.\n\n"
                         f"QA FINDINGS:\n{findings}\n\nCURRENT TEST RUN ({cmd}): {'PASS' if ok else 'FAIL'}\n{out}")
    show(f"developer ({st})", summary)
    print("next: team.py qa " + ns.story)


def c_qa(ns):
    key = story_key(ns.story)
    s = load(key, {})
    if not s.get("base"):
        sys.exit("No development recorded for this story. Run: team.py dev STORY")
    ok, cmd, out = run_tests()
    st, summary = direct(team()["agents"]["QA"], "read_only",
                         f"QA REVIEW of the story in {ns.story}. Read the story. VALIDATION is the unit test run "
                         f"(it ran in the operator's shell, so you do not need to run it).\n\nVALIDATION ({cmd}): "
                         f"{'PASS' if ok else 'FAIL'}\n{out}\n\n{changes_section(s['base'])}")
    v = verdict(summary) or {}
    passed = ok and v.get("verdict") == "pass"
    save(key, dict(s, findings=v.get("findings") or ([] if ok else ["unit tests fail - see the test output"]),
                   qaPassed=passed))
    show(f"QA ({st})", summary)
    print("QA passed - next: team.py final " + ns.story if passed else "QA found problems - next: team.py fix " + ns.story)


def c_final(ns):
    key = story_key(ns.story)
    s = load(key, {})
    if not s.get("qaPassed") and not ns.force:
        sys.exit("QA has not passed this story yet (team.py qa STORY), or pass --force.")
    ok, cmd, out = run_tests()
    st, summary = direct(team()["agents"]["TeamLead"], "workspace_write",
                         f"FINAL REVIEW of the story in {ns.story} after QA passed. Read the story. If the work is "
                         f"complete, update the story file (Status Done with today's date, ticked items, Evidence) as "
                         f"your role instructions say; change nothing else.\n\nVALIDATION "
                         f"({cmd}): {'PASS' if ok else 'FAIL'}\n{out}\n\nQA FINDINGS AT PASS:\n"
                         + ("\n".join(f"- {f}" for f in s.get("findings") or []) or "(none)")
                         + f"\n\n{changes_section(s['base'])}")
    v = verdict(summary) or {}
    m = re.search(r"```commit\s*\n(.*?)```", summary, re.S)
    save(key, dict(s, finalPassed=v.get("verdict") == "pass", commitMessage=m.group(1).strip() if m else None,
                   finalReview=summary))
    show(f"team lead final review ({st})", summary)
    if v.get("verdict") == "pass":
        print("Approved - next: team.py commit " + ns.story)
    else:
        save(key, dict(load(key), findings=v.get("findings") or [], qaPassed=False))
        print("Changes requested - next: team.py fix " + ns.story + "  (the lead's findings are passed to the dev)")


def integration_gate(skip):
    """The slow tier: the unit suite plus the integration modules this change touched, in parallel, before commit."""
    if skip:
        print("Integration tests skipped (--skip-integration).")
        return
    print("--> integration gate: python3 scripts/validate.py --touched (can take a few minutes)", flush=True)
    p = subprocess.run(["python3", os.path.join(WS, "scripts", "validate.py"), "--touched"], cwd=WS)
    if p.returncode != 0:
        sys.exit("Tests failed. Fix them (team.py fix STORY, then qa / final) or commit anyway with --skip-integration.")


def c_commit(ns):
    key = story_key(ns.story)
    s = load(key, {})
    if not s.get("finalPassed"):
        sys.exit("The team lead has not approved the final result (team.py final STORY).")
    integration_gate(ns.skip_integration)
    msg = s.get("commitMessage") or f"Implement {os.path.basename(ns.story)}"
    print(sh("git", "status", "--short").stdout)
    show("commit message", msg)
    if input("Commit all of the above with this message? [y/N] ").strip().lower() != "y":
        sys.exit("Not committed.")
    sh("git", "add", "-A")
    p = subprocess.run(["git", "commit", "-F", "-"], cwd=WS, input=msg + "\n", text=True)
    if p.returncode == 0:
        save(key, dict(s, committed=sh("git", "rev-parse", "HEAD").stdout.strip()))
        print("Committed (including the story's Done status and Evidence from the final review).")


def stuck():
    """Assignments that hold an agent until the operator decides (waiting_input / reconciling)."""
    d = cli("snapshot", "--team", team()["teamId"])
    names = {a["id"]: a for a in d.get("agents", [])}
    return [(a, names.get(a.get("agentId"), {})) for a in d.get("assignments", [])
            if a["status"] in ("waiting_input", "reconciling")]


def c_blocked(_):
    items = stuck()
    if not items:
        print("No agent is waiting for a decision.")
    for a, ag in items:
        res = a.get("result") or {}
        att = res.get("attention") or {}
        print(f"\n{ag.get('role', '?')} ({ag.get('displayName')}) - assignment {a['id']} is {a['status']}"
              f" ({res.get('diagnosticCode') or ''})")
        print(f"  summary: {(res.get('summary') or '')[:300]}")
        for item in att.get("items") or []:
            print(f"  {att.get('kind')}: {item}")
        role = ag.get("role", "ROLE")
        print(f"  decide with:  team.py resolve {role} --action fail     (accept it as failed; the agent is free)\n"
              f"                team.py resolve {role} --action retry    (run the same task again)\n"
              f"                team.py resolve {role} --action cancel")


def c_resolve(ns):
    items = [(a, ag) for a, ag in stuck() if ag.get("role", "").lower() == ns.role.lower()]
    if not items:
        sys.exit(f"No {ns.role} assignment is waiting for a decision (team.py blocked shows them all).")
    for a, _ in items:
        cli("assignment", "resolve", "--assignment", a["id"], "--action", ns.action)
        print(f"{ns.role}: assignment {a['id'][:8]} resolved with {ns.action}.")


def bindings_for(binds):
    """--bind ROLE=NAME (agent display name or role) -> {role: agentId} from the saved team."""
    agents = team()["agents"].values()
    out = {}
    for item in binds or []:
        role, sep, who = item.partition("=")
        if not sep or not role.strip() or not who.strip():
            sys.exit(f"--bind expects ROLE=AGENT_NAME, got {item!r}")
        match = [a for a in agents if who.strip().lower() in (str(a.get("name")).lower(), a["role"].lower())]
        if len(match) != 1:
            sys.exit(f"--bind {item}: no single agent named {who!r} in the saved team")
        out[role.strip()] = match[0]["agentId"]
    return out


def run_prompt(ns):
    if ns.story:
        story_key(ns.story)
        return (f"The story to deliver is in {ns.story}. Read it first. The implementer follows its 'Implement in "
                f"this order' steps and makes every 'Done when' item true, with unit tests in tests/unit; nobody "
                f"marks the story Done or edits its Status line until the team lead's final review.")
    if ns.prompt_file:
        return open(os.path.join(WS, ns.prompt_file) if not os.path.isabs(ns.prompt_file) else ns.prompt_file,
                    encoding="utf-8").read()
    if ns.prompt:
        return ns.prompt
    sys.exit("run needs a PROMPT, --story PATH or --prompt-file PATH")


def run_args(ns, text):
    t = team()
    args = ["workflow", "start", "--team", t["teamId"], "--definition", ns.name, "--text-file", "-"]
    for role, agent in bindings_for(ns.bind).items():
        args += ["--bind", f"{role}={agent}"]
    return args + ([] if ns.no_wait else ["--wait"])


def summarize(d):
    """(route, status, last findings, last stage summary, commit message) of a finished workflow detail."""
    wf = d["workflowRun"]
    asg = {a["id"]: a for a in d.get("assignments", [])}
    findings, last, commit = [], "", None
    for sa in d.get("stageAttempts", []):
        if sa.get("verdict"):
            findings = (sa["verdict"] or {}).get("findings") or []
        a = asg.get(sa.get("assignmentId"))
        if a:
            res = a.get("result") or {}
            last = res.get("finalText") or res.get("summary") or ""
            m = re.search(r"```commit\s*\n(.*?)```", last, re.S)
            commit = m.group(1).strip() if m and sa.get("outcome") == "verdict_pass" else None
    return d.get("route") or "", wf["status"], findings, last, commit


def c_run(ns):
    text = run_prompt(ns)
    if sh("git", "status", "--porcelain").stdout.strip():
        sys.exit("The workspace has uncommitted changes; commit or stash them first (the workflow needs a clean start).")
    base = sh("git", "rev-parse", "HEAD").stdout.strip()
    print(f"--> workflow {ns.name}", flush=True)
    d = cli(*run_args(ns, text), stdin=text)
    if ns.no_wait:
        print(f"started workflow {d['workflowRunId']}; follow it with: agent-studio workflow show --workflow "
              f"{d['workflowRunId']} --pretty")
        return
    route, status, findings, last, commit = summarize(d)
    print(f"route: {route}\nstatus: {status}")
    if findings:
        show("last findings", "\n".join(f"- {f}" for f in findings))
    show("last stage summary", last or "(none)")
    if ns.story:
        key = story_key(ns.story)
        save(key, dict(load(key, {}), story=ns.story, base=base, workflow=d["workflowRun"]["id"], findings=findings,
                       qaPassed=status == "succeeded", finalPassed=status == "succeeded" and bool(commit),
                       commitMessage=commit))
        if status == "succeeded" and commit:
            print("Approved - next: team.py commit " + ns.story)
        elif status != "succeeded":
            print("Not finished - fix and run again, or loop by hand with team.py fix / qa / final.")


def c_workflows(_):
    d = cli("workflow", "list", "--team", team()["teamId"])
    for x in d["definitions"]:
        mark = "built-in" if x.get("builtin") else "project "
        bad = f"  INVALID ({len(x['errors'])} error(s))" if x.get("errors") else ""
        print(f"  {x['name']:24} {mark}  {x.get('description') or ''}{bad}")


def c_check(ns):
    d = cli("workflow", "validate", "--team", team()["teamId"], "--definition", ns.name)
    print(f"{d['definition']}: OK  stages: {' -> '.join(s['id'] for s in d['stages'])}")
    for role, a in d["bindings"].items():
        print(f"  {role:10} -> {a.get('name') or a['agentId']}")
    for w in d.get("warnings") or []:
        print(f"  warning: {w.get('message')} ({w.get('path')})")


def c_index(_):
    if not shutil.which("ctags"):
        sys.exit("ctags is not installed. Run: sudo apt install universal-ctags")
    out = os.path.join(WS, ".agent-studio", "cache")
    os.makedirs(out, exist_ok=True)
    sh("ctags", "-R", "--languages=Python,JavaScript,TypeScript,Markdown", "--fields=+nS", "--exclude=.git",
       "--exclude=node_modules", "--exclude=__pycache__", "--exclude=_to_delete", "-f", os.path.join(out, "tags"), ".")
    n = sum(1 for _ in open(os.path.join(out, "tags"), encoding="utf-8", errors="replace") if not _.startswith("!_"))
    print(f"indexed {n} symbols -> .agent-studio/cache/tags (re-run after big changes; agents treat it as a hint)")


def c_wf_op(op):
    def run(_):
        d = cli("snapshot", "--team", team()["teamId"])
        runs = [w for w in d.get("workflowRuns", []) if w.get("status") in ("running", "paused")]
        if not runs:
            sys.exit("No running or paused workflow for this team.")
        wf = runs[-1]
        r = cli("workflow", op, "--workflow", wf["id"])
        print(f"workflow {wf['id'][:8]}: stage {r.get('stage')} retried (new assignment {str(r.get('newAssignmentId'))[:8]})")
    return run


def c_stop(_):
    cli("team", "stop", "--team", team()["teamId"])
    save("team", None)
    print("Team stopped.")


def c_bug(ns):
    if (ns.text is None) == (ns.file is None):
        print("Give exactly one of TEXT or --file PATH.", file=sys.stderr)
        raise SystemExit(2)
    if ns.file is not None:
        try:
            with open(ns.file, "r", encoding="utf-8") as f:
                text = f.read()
        except (OSError, UnicodeDecodeError) as e:
            sys.exit(f"Cannot read bug text: {e}")
    else:
        text = ns.text
    args = ["ticket", "create", "--workspace", WS, "--kind", "bug", "--text", text]
    for path in ns.attach:
        args.extend(("--attach", path))
    result = cli(*args)
    print(result["ticket"]["key"])


def main():
    import argparse
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("start", "attach", "status", "stop", "blocked"):
        sub.add_parser(name)
    rp = sub.add_parser("resolve")
    rp.add_argument("role")
    rp.add_argument("--action", required=True, choices=["fail", "retry", "cancel"])
    sub.add_parser("workflows")
    sub.add_parser("index")
    sub.add_parser("retry")
    ck = sub.add_parser("check")
    ck.add_argument("name")
    rn = sub.add_parser("run")
    rn.add_argument("name")
    rn.add_argument("prompt", nargs="?")
    rn.add_argument("--story")
    rn.add_argument("--prompt-file")
    rn.add_argument("--bind", action="append", default=[])
    rn.add_argument("--no-wait", action="store_true")
    u = sub.add_parser("unpack")
    u.add_argument("brief")
    u.add_argument("--out", required=True)
    bug = sub.add_parser("bug")
    bug.add_argument("text", nargs="?")
    bug.add_argument("--file")
    bug.add_argument("--attach", action="append", default=[])
    for name in ("review", "dev", "fix", "qa", "final", "commit"):
        p = sub.add_parser(name)
        p.add_argument("story")
        p.add_argument("--force", action="store_true")
        if name == "commit":
            p.add_argument("--skip-integration", action="store_true")
    ns = ap.parse_args()
    {"start": c_start, "attach": c_attach, "status": c_status, "stop": c_stop, "unpack": c_unpack,
     "review": c_review, "blocked": c_blocked, "resolve": c_resolve, "dev": c_dev, "fix": c_fix, "qa": c_qa, "final": c_final, "commit": c_commit,
     "run": c_run, "index": c_index, "retry": c_wf_op("retry"), "workflows": c_workflows, "check": c_check,
     "bug": c_bug}[ns.cmd](ns)


if __name__ == "__main__":
    main()
