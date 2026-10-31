"""opencode adapter (P00-S11). Verified against the installed CLI v2.2.5: run-scoped permissions are injected
through OPENCODE_CONFIG_CONTENT; see CONTRACT.md."""
from .adapter import OpenCodeAdapter

ADAPTER = OpenCodeAdapter()
