#!/usr/bin/env python3
"""The project's test command. Runs outside any agent sandbox.

    validate.py --unit       the whole unit suite (seconds). The workflow's `tests` stage uses this.
    validate.py --touched    the unit suite, then the integration modules the change added or modified
                             (git status), run in parallel. `team commit` uses this.
    validate.py --all        the unit suite, then every integration module, in parallel.

VALIDATE_WORKERS sets the parallelism (default 4); each integration module uses its own isolated sandbox.
Exit 0 only when everything that ran passed. Passing steps print a summary line, failing steps print their output."""
import concurrent.futures
import glob
import os
import re
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


def parse_mode(argv: list) -> str:
    modes = [a for a in argv if a in MODES]
    if len(modes) != 1 or len(argv) != 1:
        raise SystemExit("usage: validate.py --unit | --touched | --all")
    return modes[0]


def run_step(argv: list):
    """(exit code, output) of one step: own process group, output to a file rather than a pipe, so a test that
    leaves a background process behind (a coordinator, tmux) cannot keep this step waiting."""
    with tempfile.TemporaryFile() as out:
        p = subprocess.Popen(argv, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
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
        mods = all_integration_modules()
    else:
        status = subprocess.run(["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd=ROOT,
                                stdout=subprocess.PIPE, text=True).stdout
        mods = integration_modules(status)
    if mods:
        ok = run_integration(mods) and ok
    else:
        print("===== integration tests: none changed, not run\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
