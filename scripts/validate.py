#!/usr/bin/env python3
"""The project's validation command (.agent-studio/workflow.json). Runs outside any agent sandbox.

1. the whole unit suite;
2. the integration test modules the change touched (added or modified files under tests/integration), because
   integration tests need tmux and sockets that sandboxed agents cannot use. VALIDATE_ALL_INTEGRATION=1 runs them all.

Exit 0 only when everything that ran passed. Passing runs print a short summary; failing runs print the output."""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UNIT = ["python3", "-W", "ignore", "-m", "unittest", "discover", "-s", "tests/unit", "-t", "."]


def integration_modules(porcelain: str) -> list:
    """Dotted module names of changed integration test files, from `git status --porcelain=v1` text."""
    mods = []
    for line in porcelain.splitlines():
        path = line[3:].split(" -> ")[-1].strip().strip('"')
        if re.fullmatch(r"tests/integration/test_[A-Za-z0-9_]+\.py", path) and os.path.exists(os.path.join(ROOT, path)):
            mods.append(path[:-3].replace("/", "."))
    return sorted(set(mods))


def run(title: str, argv: list) -> bool:
    print(f"===== {title}: {' '.join(argv)}", flush=True)
    p = subprocess.run(argv, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out = p.stdout.strip()
    print("\n".join(out.splitlines()[-6:]) if p.returncode == 0 else out[-20000:], flush=True)
    print(f"===== {title}: {'PASS' if p.returncode == 0 else 'FAIL'}\n", flush=True)
    return p.returncode == 0


def main() -> int:
    ok = run("unit tests", UNIT)
    if os.environ.get("VALIDATE_ALL_INTEGRATION"):
        mods = ["discover", "-s", "tests/integration", "-t", "."]
    else:
        status = subprocess.run(["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd=ROOT,
                                stdout=subprocess.PIPE, text=True).stdout
        mods = integration_modules(status)
    if mods:
        ok = run("integration tests", ["python3", "-W", "ignore", "-m", "unittest"] + mods) and ok
    else:
        print("===== integration tests: none changed, not run\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
