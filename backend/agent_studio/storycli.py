"""`agent-studio team unpack | review | dev | fix | qa | final | commit | index` (P04-S05).

Operator-side glue: it builds the task texts, runs git, the validation command and
ctags in the CLI process (agents cannot run commands) and keeps the per-story state files under
<state home>/agent-studio/project-team/<slug of workspace root>/story-<key>.json, the directory and file
format earlier releases wrote, so a story begun before P04-S05 continues here. Agents are reached only
through the existing dispatch commands (team.status, task.direct, workflow.start). Nothing here touches
board code or sends a board.* / ticket.* command.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys

from . import teamcli, watch
from .protocol import AsError, BAD_REQUEST, envelope

ACTIONS = ("unpack", "review", "dev", "fix", "qa", "final", "commit", "index")
STORY_NOT_READY = "STORY_NOT_READY"
WORKSPACE_DIRTY = "WORKSPACE_DIRTY"
TESTS_FAILED = "TESTS_FAILED"
NOT_COMMITTED = "NOT_COMMITTED"
ROLE_UNBOUND = "ROLE_UNBOUND"
ROLE_AMBIGUOUS = "ROLE_AMBIGUOUS"

LIMIT = 30 * 1024            # agent-studio accepts task text up to 32 KiB
DIFF_LIMIT, TEST_LIMIT = 16 * 1024, 5 * 1024
PLANNING = ("phases/", "PRD.md", "ROADMAP.md")


# ---- plumbing ---------------------------------------------------------------------------------------------

def sh(ws, *argv, check=True):
    p = subprocess.run(list(argv), cwd=ws, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if check and p.returncode != 0:
        raise AsError(BAD_REQUEST, f"command failed: {' '.join(argv)}\n{p.stdout}")
    return p


def clip(text, n):
    b = text.encode()
    return text if len(b) <= n else b[:n].decode(errors="ignore") + f"\n[... truncated, {len(b) - n} more bytes]"


def verdict(text):
    for line in reversed((text or "").strip().splitlines()):
        line = line.strip().strip("`")
        if line.startswith("{") and '"verdict"' in line:
            try:
                return json.loads(line)
            except ValueError:
                pass
    return None


def diff_since(ws, base):
    d = sh(ws, "git", "diff", base, check=False).stdout
    for f in sh(ws, "git", "ls-files", "--others", "--exclude-standard").stdout.split():
        d += sh(ws, "git", "diff", "--no-index", "--", "/dev/null", f, check=False).stdout
    return d


def changes_section(ws, base):
    """The diff when it fits; otherwise the list of changed files, which the reviewer reads itself (it has the
    Read tool). Never a cut-off diff: a reviewer shown half the code reports the other half as missing."""
    diff = diff_since(ws, base)
    changed = sh(ws, "git", "diff", "--name-status", base, check=False).stdout.strip().splitlines()
    changed += [f"A\t{f}" for f in sh(ws, "git", "ls-files", "--others", "--exclude-standard").stdout.split()]
    listing = "\n".join(changed) or "(no changes)"
    if len(diff.encode()) <= DIFF_LIMIT:
        return f"CHANGED FILES since {base[:12]}:\n{listing}\n\nDIFF:\n{diff or '(no changes)'}"
    return (f"CHANGED FILES since {base[:12]} (A = new, M = modified, D = deleted):\n{listing}\n\n"
            f"The full diff is {len(diff.encode()) // 1024} KiB, too large to include here. Read every changed "
            f"file listed above in full before judging; do not report anything as missing without reading the "
            f"file where it would be.")


def validation_argv(argv, integration=False):
    """The manual loop commands (fix / qa / final) run only the fast unit tier unless asked; the workflow's tests stage
    and the commit gate are where integration modules run."""
    if integration:
        return list(argv)
    return ["--unit" if a in ("--touched", "--all") else a for a in argv]


def run_tests(ws, integration=False):
    try:
        with open(os.path.join(ws, ".agent-studio", "workflow.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        argv = validation_argv(cfg["validation"]["argv"], integration)
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise AsError(BAD_REQUEST, f"Cannot read validation.argv from .agent-studio/workflow.json: {e}")
    timeout = cfg["validation"].get("timeoutMs", 180000) / 1000
    sys.stderr.write(f"--> running {' '.join(argv)}\n")
    try:
        p = subprocess.run(argv, cwd=ws, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, " ".join(argv), f"timed out after {timeout:g} s"
    return p.returncode == 0, " ".join(argv), p.stdout[-TEST_LIMIT:]


def changed_paths(ws):
    out = sh(ws, "git", "status", "--porcelain", "--untracked-files=all").stdout.splitlines()
    return [l[3:].split(" -> ")[-1].strip('"') for l in out if l.strip()]


# ---- per-story state (directory, file names and format unchanged from earlier releases) --------------------

def state_dir(ws):
    return os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "agent-studio",
                        "project-team", re.sub(r"[^A-Za-z0-9]+", "_", ws).strip("_"))


def story_key(ws, story):
    if not os.path.isfile(os.path.join(ws, story)):
        raise AsError(BAD_REQUEST, f"Story file not found in the workspace: {story}")
    return "story-" + re.sub(r"[^A-Za-z0-9]+", "_", os.path.splitext(os.path.basename(story))[0])


def load_state(ws, key, default=None):
    try:
        with open(os.path.join(state_dir(ws), key + ".json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_state(ws, key, data):
    d = state_dir(ws)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, key + ".json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def not_ready(message, remediation):
    return AsError(STORY_NOT_READY, message, remediation=remediation)


def require_clean(ws):
    if sh(ws, "git", "status", "--porcelain").stdout.strip():
        raise AsError(WORKSPACE_DIRTY, "The workspace has uncommitted changes (the workflow needs a clean start).",
                      remediation="commit or stash them first")


def head(ws):
    return sh(ws, "git", "rev-parse", "HEAD").stdout.strip()


def story_prompt(ws, story):
    story_key(ws, story)
    return (f"The story to deliver is in {story}. Read it first. The implementer follows its 'Implement in "
            f"this order' steps and makes every 'Done when' item true, with unit tests in tests/unit; nobody "
            f"marks the story Done or edits its Status line until the team lead's final review.")


def run_summary(detail):
    """(findings, last stage text, commit message) of a finished workflow detail."""
    asg = {a["id"]: a for a in detail.get("assignments", [])}
    findings, last, commit = [], "", None
    for sa in detail.get("stageAttempts", []):
        if sa.get("verdict"):
            findings = (sa["verdict"] or {}).get("findings") or []
        a = asg.get(sa.get("assignmentId"))
        if a:
            res = a.get("result") or {}
            last = res.get("finalText") or res.get("summary") or ""
            m = re.search(r"```commit\s*\n(.*?)```", last, re.S)
            commit = m.group(1).strip() if m and sa.get("outcome") == "verdict_pass" else None
    return findings, last, commit


def save_run(ws, story, base, detail):
    """What `commit` needs after `run-workflow --story`; returns (key, state)."""
    key = story_key(ws, story)
    findings, _, commit = run_summary(detail)
    status = detail["workflowRun"]["status"]
    state = dict(load_state(ws, key, {}), story=story, base=base, workflow=detail["workflowRun"]["id"],
                 findings=findings, qaPassed=status == "succeeded",
                 finalPassed=status == "succeeded" and bool(commit), commitMessage=commit)
    save_state(ws, key, state)
    return key, state


# ---- one command run ---------------------------------------------------------------------------------------

class _Run:
    def __init__(self, ns):
        from . import cli
        self.ns = ns
        self.ws = cli._team_workspace(ns)
        self._team = None

    def say(self, text):
        if not self.ns.json:
            print(text, flush=True)

    def show(self, title, body):
        self.say(f"\n===== {title} =====\n{body.strip()}\n")

    def team(self):
        if self._team is None:
            self._team = teamcli._running_team(self.ns, self.ns.action)
        return self._team

    def member(self, role, override=None):
        """The member that plays `role`: --member wins, else exactly one member must have the role."""
        _, members = self.team()
        if override:
            return teamcli._member(members, override)
        rows = [m for m in members if (m.get("role") or "").casefold() == role.casefold()]
        names = ", ".join(m["name"] for m in rows or members)
        if not rows:
            raise AsError(ROLE_UNBOUND, f"No member of the team has the role {role!r}.",
                          remediation=f"pass --member <name>; members: {names}")
        if len(rows) > 1:
            raise AsError(ROLE_AMBIGUOUS, f"{len(rows)} members have the role {role!r}.",
                          remediation=f"pass --member <name>; candidates: {names}")
        return rows[0]

    def _busy_hint(self, fail, who):
        err = fail.resp.get("error") or {}
        if err.get("code") == "AGENT_BUSY" and "waiting_input" in (err.get("message") or ""):
            err["remediation"] = ("the member's previous task stopped on a permission denial; see it with "
                                  f"agent-studio team blocked, then agent-studio team resolve --member "
                                  f"{who['name']} --action fail")
        return fail

    def direct(self, who, policy, text):
        """Run one direct task to completion; returns (status, text of the agent's last message)."""
        team, _ = self.team()
        sys.stderr.write(f"--> {who['name']} ({who['role']}, {policy})\n")
        try:
            receipt = teamcli._write_call("task.direct", {"teamId": team["id"], "agentId": who["agentId"],
                                                          "policy": policy, "text": clip(text, LIMIT)})
        except teamcli._Fail as f:
            raise self._busy_hint(f, who)
        sys.stderr.write(f"accepted: task {receipt['taskId']} assignment {receipt['assignmentId']}\n")
        detail = teamcli._follow("task", watch.follow, receipt["assignmentId"], receipt["taskId"])
        assignments = detail["assignments"]
        a = next((x for x in assignments if x["id"] == receipt["assignmentId"]), assignments[-1])
        res = a.get("result") or {}
        # finalText is the agent's whole last message (summary is cut at 2000 characters)
        return a["status"], res.get("finalText") or res.get("summary") or res.get("diagnosticCode") or ""

    def result(self, story, key, status, output, hint, **extra):
        data = {"story": story, "key": key, "state": load_state(self.ws, key) if key else None, "status": status,
                "output": output}
        data.update(extra)
        return data, lambda d: hint


def _need_base(r, state, story):
    if not state.get("base"):
        raise not_ready("No development recorded for this story.", f"run agent-studio team dev {story} first")


# ---- commands ---------------------------------------------------------------------------------------------

def _unpack(ns):
    r = _Run(ns)
    try:
        with open(os.path.join(r.ws, ns.brief), encoding="utf-8") as f:
            brief = f.read()
    except (OSError, UnicodeDecodeError) as e:
        raise AsError(BAD_REQUEST, f"Cannot read the brief {ns.brief}: {e}")
    _, members = r.team()
    if ns.member:
        who = r.member("ProductOwner", ns.member)
    elif any((m.get("role") or "").casefold() == "productowner" for m in members):
        who = r.member("ProductOwner")
    else:
        who = r.member("TeamLead")
    owner = (who.get("role") or "").casefold() == "productowner"
    role = "ProductOwner" if owner else who["role"]
    manifest = " Include tickets.json with the manifest schema from your role file." if owner else ""
    st, out = r.direct(who, "workspace_write",
                       f"UNPACK this feature into phases -> epics -> stories. Write the plan into {ns.out}/ "
                       f"(a README.md overview plus one story file per story, following the story-format skill).{manifest} "
                       f"Read PRD.md, ROADMAP.md and the existing phases/ first.\n\nFEATURE BRIEF ({ns.brief}):\n{brief}")
    r.show(f"{role} ({st})", out)
    hint = (f"Review the files, answer the {role}'s open questions in the brief, and run unpack again to revise.\n"
            "Commit the plan before developing stories: git add -A && git commit -m 'Plan: ...'")
    return r.result(None, None, st, out, hint)


def _review(ns):
    r = _Run(ns)
    key = story_key(r.ws, ns.story)
    who = r.member("TeamLead", ns.member)
    before = set(changed_paths(r.ws))
    st, out = r.direct(who, "workspace_write",
                       f"REVIEW A STORY BEFORE WORK. Story file: {ns.story}. Read it and the documents it links. "
                       f"Fix what you can in the story (and, if a shared contract changes, the phase README and "
                       f"dependent stories), as your role instructions say.")
    v = verdict(out)
    approved = bool(v and v.get("verdict") == "pass")
    edited = sorted(set(changed_paths(r.ws)) - before)
    save_state(r.ws, key, dict(load_state(r.ws, key, {}), story=ns.story, approved=approved, review=out))
    r.show(f"team lead review ({st})", out)
    if edited:
        planning = [p for p in edited if p.startswith(PLANNING)]
        other = [p for p in edited if p not in planning]
        r.say("Files the team lead changed:\n  " + "\n  ".join(edited))
        if other:
            r.say("WARNING: changes outside the planning documents - check them before committing:\n  "
                  + "\n  ".join(other))
        if (planning and not ns.json
                and input("Commit the planning changes now? [Y/n] ").strip().lower() in ("", "y", "yes")):
            sh(r.ws, "git", "add", "--", *planning)
            sh(r.ws, "git", "commit", "-q", "-m", f"Review {os.path.basename(ns.story)}: story updated by the team lead",
               "--", *planning)
            r.say("Committed.")
    hint = (f"APPROVED - next: agent-studio team dev {ns.story}" if approved else
            "NOT approved - answer the lead's questions (edit the story, or add them to the task), then review again.")
    return r.result(ns.story, key, st, out, hint, editedFiles=edited)


def _dev(ns):
    r = _Run(ns)
    key = story_key(r.ws, ns.story)
    s = load_state(r.ws, key, {})
    if not s.get("approved") and not ns.force:
        raise not_ready("The team lead has not approved this story.",
                        f"run agent-studio team review {ns.story} (or pass --force)")
    require_clean(r.ws)
    base = head(r.ws)
    developer, reviewer = r.member("Developer"), r.member("QA")
    team, _ = r.team()
    text = (f"Implement the story in {ns.story}. Read it first, follow its 'Implement in this order' steps, and make "
            f"every 'Done when' item true. Add unit tests in tests/unit for the new behaviour. Do not mark the story "
            f"Done and do not edit its Status line; the team lead does that after review.")
    sys.stderr.write("--> workflow: dev implements -> unit tests -> QA review (-> one repair round)\n")
    try:
        receipt = teamcli._write_call("workflow.start", {"teamId": team["id"], "developerAgentId": developer["agentId"],
                                                         "reviewerAgentId": reviewer["agentId"], "text": text})
    except teamcli._Fail as f:
        raise r._busy_hint(f, developer)
    sys.stderr.write(f"accepted: workflow {receipt['workflowRunId']} (base {receipt['baseCommit'][:12]})\n")
    d = teamcli._follow("workflow", watch.follow_workflow, receipt["workflowRunId"])
    wf = d["workflowRun"]
    findings, last_val = [], None
    for sa in d.get("stageAttempts", []):
        if sa.get("verdict"):
            findings = sa["verdict"].get("findings") or []
        if sa.get("validation"):
            last_val = sa["validation"]
    save_state(r.ws, key, dict(s, story=ns.story, base=base, workflow=wf["id"], findings=findings,
                               qaPassed=wf["status"] == "succeeded"))
    body = "\n".join(f"- {f}" for f in findings) or "(no findings)"
    r.show(f"workflow {wf['id'][:8]}: {wf['status']}", body)
    if last_val:
        r.say(f"last test run: {'passed' if last_val.get('passed') else 'FAILED'}")
    if wf["status"] == "succeeded":
        hint = f"QA passed - next: agent-studio team final {ns.story}"
    else:
        hint = ("Not finished - the changes are still in the workspace. Loop with:\n"
                f"  agent-studio team fix {ns.story}   then   agent-studio team qa {ns.story}   "
                "(repeat until QA passes)")
    return r.result(ns.story, key, wf["status"], body, hint)


def _fix(ns):
    r = _Run(ns)
    key = story_key(r.ws, ns.story)
    s = load_state(r.ws, key, {})
    _need_base(r, s, ns.story)
    who = r.member("Developer", ns.member)
    blockers = [f for f in s.get("findings") or [] if not str(f).upper().startswith("SUGGESTION")]
    findings = "\n".join(f"- {f}" for f in blockers) or "(see the test output)"
    ok, cmd, out = run_tests(r.ws, ns.integration)
    st, summary = r.direct(who, "workspace_write",
                           f"Fix the QA blockers for the story in {ns.story}. Change only what they need; ignore suggestions.\n\n"
                           f"QA FINDINGS:\n{findings}\n\nCURRENT TEST RUN ({cmd}): {'PASS' if ok else 'FAIL'}\n{out}")
    r.show(f"developer ({st})", summary)
    return r.result(ns.story, key, st, summary, f"next: agent-studio team qa {ns.story}")


def _qa(ns):
    r = _Run(ns)
    key = story_key(r.ws, ns.story)
    s = load_state(r.ws, key, {})
    _need_base(r, s, ns.story)
    who = r.member("QA", ns.member)
    ok, cmd, out = run_tests(r.ws, ns.integration)
    st, summary = r.direct(who, "read_only",
                           f"QA REVIEW of the story in {ns.story}. Read the story. VALIDATION is the unit test run "
                           f"(it ran in the operator's shell, so you do not need to run it).\n\nVALIDATION ({cmd}): "
                           f"{'PASS' if ok else 'FAIL'}\n{out}\n\n{changes_section(r.ws, s['base'])}")
    v = verdict(summary) or {}
    passed = ok and v.get("verdict") == "pass"
    save_state(r.ws, key, dict(s, findings=v.get("findings") or ([] if ok else ["unit tests fail - see the test output"]),
                               qaPassed=passed))
    r.show(f"QA ({st})", summary)
    hint = (f"QA passed - next: agent-studio team final {ns.story}" if passed else
            f"QA found problems - next: agent-studio team fix {ns.story}")
    return r.result(ns.story, key, st, summary, hint)


def _final(ns):
    r = _Run(ns)
    key = story_key(r.ws, ns.story)
    s = load_state(r.ws, key, {})
    if not s.get("qaPassed") and not ns.force:
        raise not_ready("QA has not passed this story yet.", f"run agent-studio team qa {ns.story} (or pass --force)")
    _need_base(r, s, ns.story)
    who = r.member("TeamLead", ns.member)
    ok, cmd, out = run_tests(r.ws, ns.integration)
    st, summary = r.direct(who, "workspace_write",
                           f"FINAL REVIEW of the story in {ns.story} after QA passed. Read the story. If the work is "
                           f"complete, update the story file (Status Done with today's date, ticked items, Evidence) as "
                           f"your role instructions say; change nothing else.\n\nVALIDATION "
                           f"({cmd}): {'PASS' if ok else 'FAIL'}\n{out}\n\nQA FINDINGS AT PASS:\n"
                           + ("\n".join(f"- {f}" for f in s.get("findings") or []) or "(none)")
                           + f"\n\n{changes_section(r.ws, s['base'])}")
    v = verdict(summary) or {}
    m = re.search(r"```commit\s*\n(.*?)```", summary, re.S)
    save_state(r.ws, key, dict(s, finalPassed=v.get("verdict") == "pass", commitMessage=m.group(1).strip() if m else None,
                               finalReview=summary))
    r.show(f"team lead final review ({st})", summary)
    if v.get("verdict") == "pass":
        hint = f"Approved - next: agent-studio team commit {ns.story}"
    else:
        save_state(r.ws, key, dict(load_state(r.ws, key), findings=v.get("findings") or [], qaPassed=False))
        hint = (f"Changes requested - next: agent-studio team fix {ns.story}  "
                "(the lead's findings are passed to the dev)")
    return r.result(ns.story, key, st, summary, hint)


def integration_gate(r, skip, story):
    """The slow tier: the unit suite plus the integration modules this change touched, in parallel, before commit."""
    if skip:
        r.say("Integration tests skipped (--skip-integration).")
        return
    r.say("--> integration gate: python3 scripts/validate.py --touched (can take a few minutes)")
    p = subprocess.run(["python3", os.path.join(r.ws, "scripts", "validate.py"), "--touched"], cwd=r.ws)
    if p.returncode != 0:
        raise AsError(TESTS_FAILED, "The integration tests failed.",
                      remediation=f"run agent-studio team fix {story}, then qa / final; or commit anyway with "
                                  "--skip-integration")


def _commit(ns):
    if ns.json:
        raise AsError(BAD_REQUEST, "commit asks for confirmation; run it without --json")
    r = _Run(ns)
    key = story_key(r.ws, ns.story)
    s = load_state(r.ws, key, {})
    if not s.get("finalPassed"):
        raise not_ready("The team lead has not approved the final result.", f"run agent-studio team final {ns.story}")
    integration_gate(r, ns.skip_integration, ns.story)
    msg = s.get("commitMessage") or f"Implement {os.path.basename(ns.story)}"
    r.say(sh(r.ws, "git", "status", "--short").stdout)
    r.show("commit message", msg)
    if input("Commit all of the above with this message? [y/N] ").strip().lower() != "y":
        raise AsError(NOT_COMMITTED, "Not committed.")
    sh(r.ws, "git", "add", "-A")
    p = subprocess.run(["git", "commit", "-F", "-"], cwd=r.ws, input=msg + "\n", text=True)
    if p.returncode != 0:
        raise AsError(BAD_REQUEST, f"git commit failed (exit {p.returncode})")
    save_state(r.ws, key, dict(s, committed=head(r.ws)))
    hint = "Committed (including the story's Done status and Evidence from the final review)."
    return r.result(ns.story, key, "committed", msg, hint)


def _index(ns):
    r = _Run(ns)
    if not shutil.which("ctags"):
        raise AsError(BAD_REQUEST, "ctags is not installed.", remediation="run: sudo apt install universal-ctags")
    out = os.path.join(r.ws, ".agent-studio", "cache")
    os.makedirs(out, exist_ok=True)
    sh(r.ws, "ctags", "-R", "--languages=Python,JavaScript,TypeScript,Markdown", "--fields=+nS", "--exclude=.git",
       "--exclude=node_modules", "--exclude=__pycache__", "--exclude=_to_delete", "-f", os.path.join(out, "tags"), ".")
    with open(os.path.join(out, "tags"), encoding="utf-8", errors="replace") as f:
        n = sum(1 for line in f if not line.startswith("!_"))
    path = ".agent-studio/cache/tags"
    hint = f"indexed {n} symbols -> {path} (re-run after big changes; agents treat it as a hint)"
    return {"symbols": n, "path": path}, lambda d: hint


_HANDLERS = {"unpack": _unpack, "review": _review, "dev": _dev, "fix": _fix, "qa": _qa, "final": _final,
             "commit": _commit, "index": _index}


def _parser(action):
    from . import cli
    p = cli._Parser(prog="agent-studio", add_help=False)
    for o in ("--team", "--workspace"):
        p.add_argument(o)
    p.add_argument("--json", action="store_true")
    if action == "unpack":
        p.add_argument("--out", required=True)
        p.add_argument("--member")
        p.add_argument("brief")
    elif action != "index":
        p.add_argument("story")
        if action in ("review", "fix", "qa", "final"):
            p.add_argument("--member")
        if action in ("dev", "final"):
            p.add_argument("--force", action="store_true")
        if action in ("fix", "qa", "final"):
            p.add_argument("--integration", action="store_true")
        if action == "commit":
            p.add_argument("--skip-integration", action="store_true")
    return p


def run(argv, pretty) -> int:
    """argv is the full argument list: ['team', ACTION, ...]."""
    from . import cli
    action = argv[1]
    render = None
    try:
        ns = _parser(action).parse_intermixed_args(argv[2:])
        ns.action = action
        data, render = _HANDLERS[action](ns)
        resp = envelope(None, True, data=data)
    except teamcli._Fail as f:
        resp = f.resp
    except AsError as e:
        resp = envelope(None, False, data=e.data, error=e.to_error())
    except KeyboardInterrupt:
        return 130
    return cli.emit(resp, render or (lambda d: ""), "--json" in argv, pretty)
