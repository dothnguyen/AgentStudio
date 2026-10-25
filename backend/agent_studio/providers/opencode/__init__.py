"""opencode adapter (P00-S11). Verified against the installed CLI v2.1.4; see CONTRACT.md for the
recorded capability gap (no injectable run-scoped permission configuration -> both policies refused)."""
from .adapter import OpenCodeAdapter

ADAPTER = OpenCodeAdapter()
