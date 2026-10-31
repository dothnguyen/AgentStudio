#!/usr/bin/env bash
# Client for scripts/windows/as-bridge.ps1: drop a request into .agent-studio-bridge/requests and wait for
# its response. Works from any shell that sees the project folder (WSL, Git Bash, a linked Claude session).
#
#   scripts/as-bridge.sh status                      is the bridge running? (age of status.json)
#   scripts/as-bridge.sh diagnose T-089              read-only ticket report
#   scripts/as-bridge.sh log [LINES]                 coordinator log tail
#   scripts/as-bridge.sh [--timeout S] ARGS...       any allowlisted agent-studio command, e.g.
#   scripts/as-bridge.sh workflow show --workflow ID
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
bridge="$root/.agent-studio-bridge"
wait_s=180
if [[ "${1:-}" == "--timeout" ]]; then wait_s="$2"; shift 2; fi
[[ $# -ge 1 ]] || { sed -n '2,10p' "$0"; exit 2; }
if [[ "$1" == "status" ]]; then
  [[ -f "$bridge/status.json" ]] || { echo "no bridge has run here (no $bridge/status.json)"; exit 1; }
  python3 - "$bridge/status.json" <<'PY'
import json, sys, datetime
s = json.load(open(sys.argv[1], encoding="utf-8-sig"))
import re
m = re.match(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?", s["lastSeen"])
seen = datetime.datetime.fromisoformat(m.group(1) + "." + (m.group(2) or "0")[:6].ljust(6, "0") + "+00:00")
age = (datetime.datetime.now(datetime.timezone.utc) - seen).total_seconds()
print(("RUNNING" if age < 15 else f"NOT RUNNING (last seen {int(age)} s ago)") + f": writes={'allowed' if s.get('allowWrites') else 'blocked'} agent-studio={s.get('agentStudio')}")
PY
  exit 0
fi
mkdir -p "$bridge/requests" "$bridge/responses"
id="r$(date +%s)-$$-$RANDOM"
python3 - "$bridge/requests" "$id" "$@" <<'PY'
import json, os, sys
d, rid, args = sys.argv[1], sys.argv[2], sys.argv[3:]
if args[0] == "diagnose":
    req = {"id": rid, "op": "diagnose", "key": args[1]}
elif args[0] == "log":
    req = {"id": rid, "op": "log", "lines": int(args[1]) if len(args) > 1 else 200}
else:
    req = {"id": rid, "args": args}
tmp = os.path.join(d, "." + rid + ".json.tmp")
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(req, f)
os.rename(tmp, os.path.join(d, rid + ".json"))
PY
resp="$bridge/responses/$id.json"
for ((i = 0; i < wait_s * 4; i++)); do
  [[ -f "$resp" ]] && break
  sleep 0.25
done
[[ -f "$resp" ]] || { echo "no response after ${wait_s}s - is the bridge running? (scripts/as-bridge.sh status)" >&2; exit 124; }
python3 - "$resp" <<'PY'
import json, sys
r = json.load(open(sys.argv[1], encoding="utf-8-sig"))
if r.get("error"):
    print("BRIDGE REFUSED:", r["error"], file=sys.stderr); sys.exit(3)
sys.stdout.write(r.get("stdout") or "")
if r.get("stderr"):
    sys.stderr.write(r["stderr"])
if r.get("timedOut"):
    print("\n[bridge: timed out]", file=sys.stderr)
sys.exit(0 if r.get("ok") else (r.get("exitCode") or 1))
PY
