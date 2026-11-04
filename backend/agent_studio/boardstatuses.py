"""Workflow status projections and optimistic board edits."""
import json

from . import boardmodel, boardsettings, boardworkflows
from .protocol import AsError, BAD_REQUEST, BOARD_CONFIG_INVALID


def _read(workspace):
    data = boardsettings._read_bytes(boardsettings._path(workspace, 'board.json'))
    config = boardmodel.load_config(workspace)
    if config.get('version') not in (3, 4):
        raise AsError(BOARD_CONFIG_INVALID, 'Workflow statuses require a version 3 or 4 board.')
    return data, json.loads(data), config


def _references(workflow):
    for key in ('startsAt', 'whileRunning', 'createdTickets'):
        if workflow.get(key):
            yield key, workflow[key]
    for outcome, value in workflow.get('end', {}).items():
        path = 'end.' + outcome
        if isinstance(value, str):
            yield path, value
        elif isinstance(value, dict):
            for key in ('status', 'returnTo'):
                if key in value:
                    yield path + '.' + key, value[key]
            for key, target in value.get('releaseCreatedTickets', {}).items():
                yield path + '.releaseCreatedTickets.' + key, target
    limit = workflow.get('limits', {}).get('failuresInARow', {})
    if 'status' in limit:
        yield 'limits.failuresInARow.status', limit['status']


def list_statuses(workspace, conn):
    data, raw, config = _read(workspace)
    loaded = boardworkflows.load(workspace, config)
    users = {s['id']: [] for s in raw['workflowStatuses']}
    for wf in loaded['workflows']:
        for how, ident in _references(wf):
            if ident in users:
                users[ident].append({'workflow': wf['name'], 'title': wf['title'], 'how': how})
    counts = dict(conn.execute('SELECT COALESCE(workflow_status, status), COUNT(*) FROM tickets WHERE workspace = ? GROUP BY COALESCE(workflow_status, status)', (workspace,)).fetchall())
    statuses = []
    for status in raw['workflowStatuses']:
        ident, kind = status['id'], status.get('kind')
        uses = users[ident]
        hows = {use['how'] for use in uses}
        kind_type = {'initial': 'start', 'done': 'done', 'closed': 'closed'}.get(kind)
        derived = kind_type or ('startsWorkflow' if 'startsAt' in hows else 'whileRunning' if 'whileRunning' in hows else 'unused')
        statuses.append({'id': ident, 'name': status.get('name', ident), 'kind': kind, 'type': derived,
                         'usedBy': uses, 'ticketCount': counts.get(ident, 0)})
    return {'statuses': statuses, 'sha256': boardsettings._sha(data)}


def change(workspace, conn, action, args, expected):
    data, raw, _ = _read(workspace)
    boardsettings._check_expected(expected, data, 'board.json')
    statuses = raw['workflowStatuses']
    if action == 'reorder':
        ids = args.get('ids')
        if not isinstance(ids, list) or any(not isinstance(i, str) for i in ids) or len(ids) != len(statuses) or set(ids) != {s['id'] for s in statuses}:
            raise AsError(BAD_REQUEST, 'ids must contain each status exactly once.')
        by_id = {s['id']: s for s in statuses}
        statuses = [by_id[i] for i in ids]
    else:
        ident = args.get('id')
        if not isinstance(ident, str) or not ident:
            raise AsError(BAD_REQUEST, 'id must be a non-empty string.')
        found = next((s for s in statuses if s['id'] == ident), None)
        if action == 'add':
            if found:
                raise AsError(BAD_REQUEST, 'Status id already exists.')
            if args.get('kind') not in ('none', 'done'):
                raise AsError(BAD_REQUEST, 'kind must be none or done.')
            found = {'id': ident}
            if args['kind'] == 'done':
                found['kind'] = 'done'
            statuses.append(found)
        elif found is None:
            raise AsError(BAD_REQUEST, 'Status id does not exist.')
        if action in ('add', 'rename'):
            name = args.get('name')
            if not isinstance(name, str) or not name.strip():
                raise AsError(BAD_REQUEST, 'name must be a non-empty string.')
            found['name'] = name
        if action == 'remove':
            loaded = boardworkflows.load(workspace, boardmodel.load_config(workspace))
            if loaded['problems']:
                raise AsError(BOARD_CONFIG_INVALID, 'Cannot verify workflow status usage.', data={'problems': loaded['problems']})
            info = next(s for s in list_statuses(workspace, conn)['statuses'] if s['id'] == ident)
            if found.get('kind') in ('initial', 'closed') or info['usedBy'] or info['ticketCount']:
                raise AsError('STATUS_IN_USE', 'Status cannot be removed.', data={'usedBy': info['usedBy'], 'ticketCount': info['ticketCount']})
            statuses = [s for s in statuses if s['id'] != ident]
    return boardsettings.update_board(workspace, {'workflowStatuses': statuses}, expected, conn)
