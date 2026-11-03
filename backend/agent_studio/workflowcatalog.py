"""Workspace board workflow and prompt file management."""
import hashlib
import json
import os
import shutil
import tempfile

from . import boardmodel, boardworkflows, workflowdef, prompts, yamlsubset
from .protocol import AsError, BAD_REQUEST, CONFIG_CHANGED


def _name(name):
    if not isinstance(name, str) or not workflowdef.NAME_RE.fullmatch(name):
        raise AsError(BAD_REQUEST, 'name must contain lowercase letters, digits and hyphens.')
    return name


def _sha(raw):
    return hashlib.sha256(raw).hexdigest() if raw is not None else None


def _read(path):
    try:
        with open(path, 'rb') as f:
            return f.read()
    except FileNotFoundError:
        return None


def _check(raw, expected):
    if _sha(raw) != expected:
        raise AsError(CONFIG_CHANGED, 'File changed since it was read.', data={'sha256': _sha(raw)})


def _write(path, raw):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.workflow-')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(raw)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _wf_path(ws, name, missing=False):
    _name(name)
    try:
        return workflowdef._locate(ws, name, None)[0]
    except AsError as e:
        if missing and e.code == 'WORKFLOW_DEFINITION_NOT_FOUND':
            return os.path.join(ws, '.agent-studio', 'workflows', name + '.json')
        raise


def show(ws, name):
    path = _wf_path(ws, name)
    raw = _read(path)
    definition, problems = None, []
    try:
        definition = json.loads(workflowdef.to_json(workflowdef.load(ws, name)))
        problems = [p for p in boardworkflows.load(ws, boardmodel.load_config(ws))['problems'] if p['workflow'] == name]
    except AsError as e:
        problems = (e.data or {}).get('errors', [{'path': '$', 'message': e.message}])
    return {'name': name, 'definition': definition, 'text': raw.decode('utf-8'), 'sha256': _sha(raw), 'problems': problems}


def save(ws, name, definition, expected):
    path = _wf_path(ws, name, True)
    _check(_read(path), expected)
    if not isinstance(definition, dict):
        raise AsError(BAD_REQUEST, 'definition must be an object.')
    raw = ((('\n'.join(json.dumps(k) + ': ' + json.dumps(v, ensure_ascii=True) for k, v in definition.items())) if path.endswith(('.yaml', '.yml')) else json.dumps(definition, indent=2, ensure_ascii=False)) + '\n').encode('utf-8')
    if len(raw) > workflowdef.MAX_DEFINITION_BYTES:
        raise AsError('BOARD_WORKFLOW_INVALID', 'Definition is too large.', data={'problems': [{'path': '$', 'message': 'Definition is too large.'}]})
    with tempfile.TemporaryDirectory() as temp:
        shutil.copytree(os.path.join(ws, '.agent-studio'), os.path.join(temp, '.agent-studio'), symlinks=True)
        candidate = os.path.join(temp, os.path.relpath(path, ws))
        # YAML uses one flow value per top-level key, supported by yamlsubset.
        _write(candidate, raw)
        try:
            parsed = workflowdef.load(temp, name)
            problems = [p for p in boardworkflows.load(temp, boardmodel.load_config(temp))['problems'] if p['workflow'] == name or (p['path'] in ('startsAt', 'whileRunning') and ('already used' in p['message'] or 'also a workflow start' in p['message']))]
            if parsed.board is None:
                problems.append({'path': 'startsAt', 'message': 'A board workflow requires startsAt.'})
        except AsError as e:
            problems = (e.data or {}).get('errors', [{'path': '$', 'message': e.message}])
        if problems:
            raise AsError('BOARD_WORKFLOW_INVALID', 'Invalid board workflow.', data={'problems': problems})
    _check(_read(path), expected)
    _write(path, raw)
    return show(ws, name)


def delete(ws, name, expected, conn):
    path = _wf_path(ws, name)
    _check(_read(path), expected)
    definition = workflowdef.load(ws, name)
    status = definition.board.while_running if definition.board else None
    rows = conn.execute('SELECT t.key FROM tickets t LEFT JOIN workflow_runs r ON r.id = t.active_run_id WHERE t.workspace = ? AND (t.workflow_status = ? OR r.definition_name = ?)', (ws, status, name)).fetchall()
    if rows:
        raise AsError('BOARD_WORKFLOW_IN_USE', 'Workflow is in use by tickets.', data={'tickets': [r[0] for r in rows]})
    os.unlink(path)
    return {'name': name}


def _prompt_path(ws, name):
    if not isinstance(name, str) or not name or name in ('.', '..') or '/' in name or '\x00' in name:
        raise AsError(BAD_REQUEST, 'Invalid prompt name.')
    return os.path.join(ws, '.agent-studio', 'workflows', 'prompts', name + '.md')


def users(ws, name):
    result = []
    for item in workflowdef.list_definitions(ws):
        for file in item['files']:
            try:
                path = os.path.join(ws, file)
                with open(path, encoding='utf-8') as f:
                    text = f.read(workflowdef.MAX_DEFINITION_BYTES + 1)
                obj = yamlsubset.loads(text) if path.endswith(('.yaml', '.yml')) else json.loads(text)
                if not isinstance(obj, dict):
                    continue
                for step in obj.get('steps', []):
                    if isinstance(step, dict) and isinstance(step.get('agent'), dict):
                        prompt = step['agent'].get('prompt')
                        if isinstance(prompt, str) and workflowdef._step_prompt_path(prompt) == 'workflows/prompts/' + name + '.md':
                            result.append({'workflow': item['name'], 'step': step.get('id')})
                for stage in obj.get('stages', []):
                    if isinstance(stage, dict) and stage.get('promptFile') == 'workflows/prompts/' + name + '.md':
                        result.append({'workflow': item['name'], 'step': stage.get('id')})
            except (OSError, UnicodeError, ValueError, TypeError, yamlsubset.YamlSubsetError):
                continue
    return result


def prompt_show(ws, name):
    raw = _read(_prompt_path(ws, name))
    if raw is None:
        raise AsError('PROMPT_NOT_FOUND', 'Prompt not found.')
    text = raw.decode('utf-8')
    return {'name': name, 'text': text, 'words': len(text.split()), 'sha256': _sha(raw), 'users': users(ws, name)}


def prompt_list(ws):
    folder = os.path.join(ws, '.agent-studio', 'workflows', 'prompts')
    if not os.path.isdir(folder):
        return {'prompts': []}
    return {'prompts': [prompt_show(ws, f[:-3]) for f in sorted(os.listdir(folder)) if f.endswith('.md') and os.path.isfile(os.path.join(folder, f))]}


def prompt_save(ws, name, text, expected):
    path = _prompt_path(ws, name)
    _check(_read(path), expected)
    if not isinstance(text, str) or not text.strip() or len(text.encode('utf-8')) > 32768:
        raise AsError(BAD_REQUEST, 'Prompt must be nonempty text of at most 32 KiB.')
    unknown = sorted(prompts.placeholders(text) - prompts.ALLOWED)
    if unknown:
        raise AsError('PROMPT_INVALID', 'Unknown placeholders.', data={'problems': [{'path': 'text', 'message': 'Unknown placeholder: ' + p} for p in unknown]})
    _write(path, text.encode('utf-8'))
    return prompt_show(ws, name)


def prompt_delete(ws, name, expected):
    path = _prompt_path(ws, name)
    raw = _read(path)
    if raw is None:
        raise AsError('PROMPT_NOT_FOUND', 'Prompt not found.')
    _check(raw, expected)
    references = users(ws, name)
    if references:
        raise AsError('PROMPT_IN_USE', 'Prompt is used by workflows.', data={'users': references})
    os.unlink(path)
    return {'name': name}
