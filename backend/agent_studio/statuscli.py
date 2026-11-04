"""CLI for workflow statuses."""
import json
from . import cli
from .protocol import AsError, BAD_REQUEST, envelope
from .teamcli import _call, _Fail


def run(argv, pretty):
    try:
        action = argv[2]
        if action not in ('list', 'add', 'rename', 'remove', 'reorder'):
            raise AsError(BAD_REQUEST, 'Unknown status action.')
        p = cli._Parser(prog='agent-studio board status', add_help=False)
        p.add_argument('--workspace')
        p.add_argument('--json', action='store_true')
        if action in ('add', 'rename', 'remove'):
            p.add_argument('id')
        if action in ('add', 'rename'):
            p.add_argument('name')
        if action == 'add':
            p.add_argument('--kind', choices=('none', 'done'), required=True)
        if action == 'reorder':
            p.add_argument('ids', nargs='+')
        if action != 'list':
            p.add_argument('--expected-sha256', required=True)
        ns = p.parse_intermixed_args(argv[3:])
        args = {'workspace': cli._team_workspace(ns)}
        for field in ('id', 'name', 'kind', 'ids'):
            if hasattr(ns, field):
                args[field] = getattr(ns, field)
        if action != 'list':
            args['expectedSha256'] = ns.expected_sha256
        data = _call('board.statuses' if action == 'list' else 'status.' + action, args)
        resp = envelope(None, True, data=data)
    except _Fail as e:
        resp = e.resp
    except (AsError, OSError, ValueError, IndexError) as e:
        err = e if isinstance(e, AsError) else AsError(BAD_REQUEST, str(e))
        resp = envelope(None, False, data=err.data, error=err.to_error())
    return cli.emit(resp, lambda d: json.dumps(d, indent=2, ensure_ascii=False), '--json' in argv, pretty)
