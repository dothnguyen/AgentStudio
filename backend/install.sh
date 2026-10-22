#!/bin/bash
# Links the entry shim to ~/.local/bin/agent-studio. Run inside the target WSL distro.
set -euo pipefail
here="$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd -P)"
# Executable bits are not reliable through git on a Windows drive (core.fileMode=false), so set them here.
chmod +x "$here/bin/agent-studio" "$here/bin/agent-studio-worker" "$here/install.sh" 2>/dev/null || true
mkdir -p "$HOME/.local/bin"
ln -sfn "$here/bin/agent-studio" "$HOME/.local/bin/agent-studio"
echo "Installed: $HOME/.local/bin/agent-studio -> $here/bin/agent-studio"
case "$here" in
  /mnt/*) echo "Note: the backend is on a Windows drive ($here). It works, but cloning into the WSL filesystem (e.g. ~/src/AgentStudio) starts faster." ;;
esac
