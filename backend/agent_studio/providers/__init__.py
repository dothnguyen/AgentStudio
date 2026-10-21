"""Provider registry. A provider is a package directory under providers/ that exposes ADAPTER; adding or
replacing one never requires a coordinator, runner, or workflow change."""
from __future__ import annotations

import importlib
import os
from typing import Dict, List

from .. import schema
from ..protocol import AsError
from .base import PROVIDER_UNAVAILABLE, Adapter

PEERS = ("codex", "claude", "agy", "opencode")
TEST_ONLY = ("fake",)
_HERE = os.path.dirname(os.path.abspath(__file__))


def available_ids() -> List[str]:
    return [d for d in sorted(os.listdir(_HERE))
            if d in schema.PROVIDERS and os.path.exists(os.path.join(_HERE, d, "__init__.py"))]


def get(provider_id: str, allow_test_only: bool = False) -> Adapter:
    if provider_id not in schema.PROVIDERS:
        raise AsError("BAD_REQUEST", f"Unknown provider {provider_id!r}.")
    if provider_id in TEST_ONLY and not allow_test_only:
        raise AsError("BAD_REQUEST", f"Provider {provider_id!r} is test-only.")
    if provider_id not in available_ids():
        raise AsError(PROVIDER_UNAVAILABLE, f"No adapter directory for {provider_id!r}.")
    adapter = importlib.import_module(f"{__name__}.{provider_id}").ADAPTER
    if adapter.provider_id != provider_id:
        raise AsError("BAD_ADAPTER", f"providers/{provider_id} exposes an adapter for {adapter.provider_id!r}.")
    return adapter


def probe_many(provider_ids, env: dict, allow_test_only: bool) -> Dict[str, dict]:
    out = {}
    for pid in dict.fromkeys(provider_ids):
        try:
            out[pid] = get(pid, allow_test_only).probe(env)
        except AsError as e:
            out[pid] = {"providerId": pid, "available": False, "reason": e.message, "code": e.code}
    return out
