"""Read and cross-check board workflow definitions."""
import json

from . import boardmodel, rolecatalog, workflowdef
from .protocol import AsError


def from_rules(workspace, config):
    """Convert validated legacy rules into independent in-memory workflows."""
    workflows = []
    for rule in config.get('rules', []):
        start = rule['when']['status']
        wf = {'name': start, 'startsAt': start, 'whileRunning': rule.get('during'),
              'role': rule.get('role'), 'end': {'pass': rule['onPass'], 'fail': rule['onFail']},
              'limits': {}}
        if rule.get('action') == 'merge':
            wf['steps'] = [{'id': 'merge', 'action': 'merge'}]
            if 'onPassCreatedTickets' in rule:
                wf['end']['pass'] = {'status': rule['onPass'],
                                     'releaseCreatedTickets': dict(rule['onPassCreatedTickets'])}
        else:
            definition = workflowdef.load(workspace, rule['workflow'], boardmodel.BUILTIN_DEFINITIONS_DIR)
            wf['steps'] = json.loads(workflowdef.to_json(definition))['stages']
            wf['workflow'] = rule['workflow']
        for source, target in [('workspace', 'workspace'), ('syncBase', 'syncBase'),
                               ('requiresDeps', 'waitForDependencies'), ('priority', 'priority'),
                               ('createdTicketStatus', 'createdTickets')]:
            if source in rule:
                wf[target] = rule[source]
        if 'onBlocked' in rule:
            wf['end']['blocked'] = {'status': rule['onBlocked']}
        for source, target in [('maxRounds', 'maxRuns'), ('onFailureLimit', 'failuresInARow'),
                               ('onFailPriority', 'onFailPriority')]:
            if source in rule:
                wf['limits'][target] = rule[source]
        workflows.append(wf)
    return workflows


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

    if config.get('rules'):
        if workflows:
            problem('', 'rules', 'board.json rules and board workflow files both define routing')
        converted = []
        for i, rule in enumerate(config['rules']):
            try:
                converted.extend(from_rules(workspace, {'rules': [rule]}))
            except AsError as error:
                problem(rule['when']['status'], f'rules[{i}].workflow', error.message)
        workflows = converted

    by_start, by_running = {}, {}
    starts = {wf['startsAt'] for wf in workflows}
    for wf in workflows:
        for key, index in [('startsAt', by_start), ('whileRunning', by_running)]:
            value = wf[key]
            if value is None:
                continue
            if value in index:
                problem(wf['name'], key, f'Status {value!r} is already used by another workflow.')
            else:
                index[value] = wf
        if wf['whileRunning'] in starts:
            problem(wf['name'], 'whileRunning', 'Status is also a workflow start status.')
    return {'workflows': workflows, 'byStart': by_start, 'byRunning': by_running, 'problems': problems}
