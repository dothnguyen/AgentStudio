"""Process entry point used by bin/agent-studio. sys.path[0] is this directory, never the caller's cwd."""
import os
import sys

if sys.version_info < (3, 8):
    sys.stdout.write('{"protocol":"agent-studio/v1","id":null,"ok":false,"error":{"code":"BACKEND_UNAVAILABLE",'
                     '"message":"Python 3.8 or newer is required.","retryable":false}}\n')
    sys.exit(1)

os.umask(0o077)  # every file and directory we create is private to the WSL user

from agent_studio.cli import main  # noqa: E402

sys.exit(main())
