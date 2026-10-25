#!/usr/bin/env python3
"""The project's test command. Runs outside any agent sandbox.

    validate.py --unit       the whole unit suite (seconds). The workflow's `tests` stage uses this.
    validate.py --touched    the unit suite, then the integration modules the change added or modified
                             (git status), run in parallel. `team commit` uses this.
    validate.py --all        the unit suite, then every integration module, in parallel.

Node packages: a top-level directory with a package.json (the Electron app under app/, for example) is also
checked by --touched when the change touches it, and always by --all: `npm ci` when node_modules is missing, then
`npm test`, `npm run typecheck`, and `npm run build` for the scripts the package defines. A missing npm is a failure,
not a skip.

VALIDATE_WORKERS sets the parallelism (default 4); each integration module uses its own isolated sandbox.
Exit 0 only when everything that ran passed. Passing steps print a summary line, failing steps print their output."""
import concurrent.futures
import glob
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UNIT = ["python3", "-W", "ignore", "-m", "unittest", "discover", "-s", "tests/unit", "-t", "."]
MODES = ("--unit", "--touched", "--all")


def integration_modules(porcelain: str) -> list:
    """Dotted module names of changed integration test files, from `git status --porcelain=v1` text."""
    mods = []
    for line in porcelain.splitlines():
        path = line[3:].split(" -> ")[-1].strip().strip('"')
        if re.fullmatch(r"tests/integration/test_[A-Za-z0-9_]+\.py", path) and os.path.exists(os.path.join(ROOT, path)):
            mods.append(path[:-3].replace("/", "."))
    return sorted(set(mods))


def all_integration_modules() -> list:
    return sorted(os.path.relpath(p, ROOT)[:-3].replace(os.sep, ".")
                  for p in glob.glob(os.path.join(ROOT, "tests", "integration", "test_*.py")))


def branch_changes() -> str:
    """Porcelain-style lines for files changed on this branch since it left the base branch, so a ticket
    worktree whose earlier rounds are already committed still counts those rounds' integration tests."""
    def git(*args):
        return subprocess.run(["git", *args], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              text=True)
    names = []
    try:
        with open(os.path.join(ROOT, ".agent-studio", "board.json"), encoding="utf-8") as f:
            names.append(json.load(f).get("baseBranch"))
    except (OSError, ValueError, AttributeError):
        pass
    for base in [n for n in names if isinstance(n, str)] + ["main", "master"]:
        merge_base = git("merge-base", "HEAD", base)
        if merge_base.returncode == 0 and merge_base.stdout.strip():
            diff = git("diff", "--name-only", "--diff-filter=AM", merge_base.stdout.strip(), "HEAD").stdout
            return "".join(" M " + line + "\n" for line in diff.splitlines())
    return ""


def parse_mode(argv: list) -> str:
    modes = [a for a in argv if a in MODES]
    if len(modes) != 1 or len(argv) != 1:
        raise SystemExit("usage: validate.py --unit | --touched | --all")
    return modes[0]


def node_packages(porcelain=None, root=None) -> list:
    """Top-level directories that hold a package.json; with porcelain text, only those the change touches."""
    root = root or ROOT
    found = []
    for manifest in sorted(glob.glob(os.path.join(root, "*", "package.json"))):
        name = os.path.basename(os.path.dirname(manifest))
        if name == "node_modules":
            continue
        if porcelain is None or any(
                line[3:].split(" -> ")[-1].strip().strip('"').startswith(name + "/") for line in porcelain.splitlines()):
            found.append(name)
    return found


def run_node_package(name: str, root=None) -> bool:
    """npm ci (when node_modules is missing), then the package's test, typecheck, and build scripts, if present."""
    root = root or ROOT
    pkg = os.path.join(root, name)
    print(f"===== node package {name}/", flush=True)
    npm = shutil.which("npm")
    if not npm:
        return report(f"{name}: npm", 1, "npm was not found on PATH: install Node.js in this environment so the "
                                         f"{name}/ tests can run")
    try:
        with open(os.path.join(pkg, "package.json"), encoding="utf-8") as f:
            scripts = json.load(f).get("scripts") or {}
    except (OSError, ValueError, AttributeError) as e:
        return report(f"{name}: package.json", 1, f"cannot read {name}/package.json: {e}")
    steps = []
    if not os.path.isdir(os.path.join(pkg, "node_modules")):
        lock = os.path.exists(os.path.join(pkg, "package-lock.json"))
        steps.append((f"{name}: npm {'ci' if lock else 'install'}",
                      [npm, "ci" if lock else "install", "--no-audit", "--no-fund"]))
    for script in ("test", "typecheck", "build"):
        if script in scripts:
            steps.append((f"{name}: npm {'test' if script == 'test' else 'run ' + script}",
                          [npm, "test"] if script == "test" else [npm, "run", script]))
    ok = True
    for title, argv in steps:
        code, text = run_step(argv, cwd=pkg)
        ok = report(title, code, text) and ok
        if code != 0 and title.endswith(("ci", "install")):
            break  # nothing else can run without dependencies
    if not steps:
        print(f"{name}/ has no test, typecheck, or build script; nothing to run\n", flush=True)
    return ok


def run_step(argv: list, cwd=None):
    """(exit code, output) of one step: own process group, output to a file rather than a pipe, so a test that
    leaves a background process behind (a coordinator, tmux) cannot keep this step waiting."""
    with tempfile.TemporaryFile() as out:
        p = subprocess.Popen(argv, cwd=cwd or ROOT, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                             start_new_session=True)
        try:
            code = p.wait()
        finally:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except OSError:
                pass
        out.seek(0)
        return code, out.read().decode("utf-8", "replace").strip()


def report(title: str, code: int, text: str) -> bool:
    print(f"===== {title}: {'PASS' if code == 0 else 'FAIL'}", flush=True)
    print("\n".join(text.splitlines()[-4:]) if code == 0 else text[-20000:], flush=True)
    print(flush=True)
    return code == 0


def run_integration(mods: list) -> bool:
    workers = max(1, int(os.environ.get("VALIDATE_WORKERS") or 4))
    print(f"===== integration tests: {len(mods)} module(s), {workers} at a time", flush=True)
    ok = True
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(run_step, ["python3", "-W", "ignore", "-m", "unittest", m]): m for m in mods}
        for f in concurrent.futures.as_completed(futures):
            code, text = f.result()
            ok = report(futures[f], code, text) and ok
    return ok


def main(argv: list) -> int:
    mode = parse_mode(argv)
    code, text = run_step(UNIT)
    ok = report("unit tests", code, text)
    if mode == "--unit":
        return 0 if ok else 1
    if mode == "--all":
        mods, packages = all_integration_modules(), node_packages()
    else:
        status = subprocess.run(["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd=ROOT,
                                stdout=subprocess.PIPE, text=True).stdout
        changes = status + branch_changes()
        mods, packages = integration_modules(changes), node_packages(changes)
    if mods:
        ok = run_integration(mods) and ok
    else:
        print("===== integration tests: none changed, not run\n")
    for name in packages:
        ok = run_node_package(name) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
