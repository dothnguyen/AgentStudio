"""CLI for board workflow and prompt files."""
import json
import sys

from . import cli
from .protocol import AsError, BAD_REQUEST, envelope
from .teamcli import _call, _Fail


def run(argv, pretty):
    board = argv[0] == 'board'
    offset = 2 if board else 1
    try:
        action = argv[offset]
        if action not in ('list', 'show', 'save', 'delete'):
            raise AsError(BAD_REQUEST, 'Unknown workflow or prompt action.')
        p = cli._Parser(prog='agent-studio', add_help=False)
        p.add_argument('--workspace')
        p.add_argument('--json', action='store_true')
        if action != 'list':
            p.add_argument('name')
        if action == 'save':
            p.add_argument('--file', required=True)
            p.add_argument('--expected-sha256')
        if action == 'delete':
            p.add_argument('--expected-sha256', required=True)
        ns = p.parse_intermixed_args(argv[offset + 1:])
        args = {'workspace': cli._team_workspace(ns)}
        if action != 'list':
            args['name'] = ns.name
        if action in ('save', 'delete'):
            args['expectedSha256'] = ns.expected_sha256
        if action == 'save':
            with open(ns.file, encoding='utf-8') as f:
                content = f.read()
            args['definition' if board else 'text'] = json.loads(content) if board else content
        data = _call(('boardworkflow.' if board else 'prompt.') + action, args)
        resp = envelope(None, True, data=data)
    except _Fail as e:
        resp = e.resp
    except (AsError, OSError, ValueError, IndexError) as e:
        err = e if isinstance(e, AsError) else AsError(BAD_REQUEST, str(e))
        resp = envelope(None, False, data=err.data, error=err.to_error())
    return cli.emit(resp, lambda d: json.dumps(d, indent=2, ensure_ascii=False), '--json' in argv, pretty)
