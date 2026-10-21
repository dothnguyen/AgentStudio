import os
import sys

os.umask(0o077)
from agent_studio.cli import main  # noqa: E402

sys.exit(main())
