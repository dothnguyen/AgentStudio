"""Read and cross-check board workflow definitions."""
import json

from . import rolecatalog, workflowdef
from .protocol import AsError


def load(workspace, config):
    statuses = {s['id']: s for s in config.get('workflowStatuses', config.get('statuses', []))}
    roles = {item['id'] for item in rolecatalog.list_roles(workspace)['items']}
    workflows, problems = [], []

    def problem(name, path, message):
        problems.append({'workflow': name, 'path': path, 'message': message})

    for entry in workflowdef.list_definitions(workspace):
        name = entry['name']
        if entry['errors']:
            for error in entry['errors']:
                problem(name, error['path'], error['message'])
            continue
        try:
            definition = workflowdef.load(workspace, name)
        except AsError as error:
            for item in (error.data or {}).get('errors', [{'path': '$', 'message': error.message}]):
                problem(name, item['path'], item['message'])
            continue
        board = definition.board
        if board is None:
            continue
        frozen = json.loads(workflowdef.to_json(definition))
        wf = {'name': name, 'startsAt': board.starts_at, 'whileRunning': board.while_running,
              'role': board.role, 'steps': [{'id': s.id, 'kind': s.kind} for s in definition.stages],
              'end': frozen['end'], 'limits': frozen['limits']}
        workflows.append(wf)

        def status(path, value):
            if value not in statuses:
                problem(name, path, f'Unknown workflow status {value!r}.')

        status('startsAt', board.starts_at)
        status('whileRunning', board.while_running)
        for path, value in [('startsAt', board.starts_at), ('whileRunning', board.while_running)]:
            if value in statuses and statuses[value].get('kind') is not None:
                problem(name, path, 'Status must have no kind.')
        if board.created_tickets is not None:
            status('createdTickets', board.created_tickets)
        for outcome, value in board.end.items():
            path = 'end.' + outcome
            if isinstance(value, str):
                status(path, value)
            else:
                status(path + '.status', value['status'])
                if 'returnTo' in value:
                    status(path + '.returnTo', value['returnTo'])
                if 'releaseCreatedTickets' in value:
                    for key, target in value['releaseCreatedTickets'].items():
                        status(path + '.releaseCreatedTickets.' + key, target)
        if 'failuresInARow' in board.limits:
            status('limits.failuresInARow.status', board.limits['failuresInARow']['status'])
        if any(s.type == 'agent' for s in definition.stages):
            if not board.role:
                problem(name, 'role', 'A workflow with an agent step requires a role.')
            elif board.role not in roles:
                problem(name, 'role', f'Unknown role {board.role!r}.')

    by_start, by_running = {}, {}
    starts = {wf['startsAt'] for wf in workflows}
    for wf in workflows:
        for key, index in [('startsAt', by_start), ('whileRunning', by_running)]:
            value = wf[key]
            if value in index:
                problem(wf['name'], key, f'Status {value!r} is already used by another workflow.')
            else:
                index[value] = wf
        if wf['whileRunning'] in starts:
            problem(wf['name'], 'whileRunning', 'Status is also a workflow start status.')
    return {'workflows': workflows, 'byStart': by_start, 'byRunning': by_running, 'problems': problems}
