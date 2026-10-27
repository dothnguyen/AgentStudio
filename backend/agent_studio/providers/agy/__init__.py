"""agy adapter. Placeholder until P00-S10 verifies the installed CLI; see CONTRACT.md."""
import os
import shutil

from ..base import NotImplementedAdapter

ADAPTER = NotImplementedAdapter("agy", "P00-S10")

_placeholder_probe = ADAPTER.probe


def _probe(env, deep=False):
    result = _placeholder_probe(env, deep=deep)
    # Empty PATH entries must not implicitly search the current directory.
    path = os.pathsep.join(part for part in env.get("PATH", "").split(os.pathsep) if part)
    found = bool(path) and any(shutil.which(name, path=path) for name in ("agy", "antigravity"))
    result["code"] = "CAPABILITY_GAP" if found else "PROVIDER_NOT_FOUND"
    return result


ADAPTER.probe = _probe
