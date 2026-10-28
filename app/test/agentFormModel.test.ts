import { describe, expect, it } from 'vitest';
import { agentChanges, agentErrorProblems, agentInput, duplicateAgentForm, duplicateAgentId, editAgentForm, emptyAgentForm, validateAgentForm } from '../src/renderer/agents/agentFormModel';
const providers = [{ id: 'p', modelSelectable: true, configuredModels: ['suggested'], reasoningLevels: ['high'] }, { id: 'q', modelSelectable: false, configuredModels: [], reasoningLevels: [] }];
const agent = { id: 'agent', name: 'Name', provider: 'p', description: 'desc', model: 'model', reasoning: 'high' };
const valid = { ...agent };
describe('agent form model', () => {
  it('duplicateAgentId chooses copy suffixes and stays a valid 64-character slug', () => { expect(duplicateAgentId('agent', ['agent-copy', 'agent-copy-2'])).toBe('agent-copy-3'); expect(duplicateAgentId('a'.repeat(64), [])).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/); });
  it('duplicateAgentForm copies mutable settings and caps the copy name at 80 characters', () => { expect(duplicateAgentForm({ id: 'a', name: 'x'.repeat(80), provider: 'p' }, [])).toEqual({ id: 'a-copy', name: 'x'.repeat(75) + ' copy', provider: 'p', model: '', reasoning: '', description: '' }); expect(duplicateAgentForm(agent, []).model).toBe('model'); });
  it('validateAgentForm rejects required, slug, collision, length, provider, model, and reasoning errors', () => { const cases = [ ['id', '', 'Enter an agent id.'], ['id', 'A', 'Use 1–64 lowercase letters, digits, or hyphens, starting with a letter or digit.'], ['id', 'agent', 'That agent id already exists.'], ['name', '', 'Enter an agent name.'], ['name', 'a'.repeat(81), 'Use 80 characters or fewer.'], ['description', 'a'.repeat(4001), 'Use 4000 characters or fewer.'], ['provider', '', 'Choose a provider.'], ['provider', 'bad', 'Choose a provider supplied by the backend.'], ['model', '?', 'Use 1–128 letters, digits, or . _ : / @ + - characters, starting with a letter or digit.'], ['reasoning', 'bad', 'Choose a reasoning level supplied for this provider.'] ] as const; for (const [field, value, message] of cases) expect(validateAgentForm({ ...valid, id: 'new', [field]: value }, 'create', ['agent'], providers)[field]).toBe(message); expect(validateAgentForm({ ...valid, provider: 'q' }, 'edit', [], providers).model).toBe('This provider does not support choosing a model.'); expect(validateAgentForm(valid, 'edit', [], []).provider).toBe('Choose a provider supplied by the backend.'); });
  it('validateAgentForm accepts a valid free-form model outside configured suggestions', () => { expect(validateAgentForm({ ...valid, model: 'other/model' }, 'edit', [], providers)).toEqual({}); });
  it('agentInput trims fields, sends all six populated values, and omits blank optional fields', () => { expect(agentInput({ id: ' a ', name: ' n ', provider: ' p ', model: ' m ', reasoning: ' r ', description: ' d ' })).toEqual({ id: 'a', name: 'n', provider: 'p', model: 'm', reasoning: 'r', description: 'd' }); expect(agentInput(emptyAgentForm(providers))).toEqual({ id: '', name: '', provider: 'p' }); });
  it('agentChanges omits id, emits only changed fields, and uses null for cleared optional fields', () => { expect(agentChanges(agent, { ...valid, id: 'other', name: 'New', description: '', model: '', reasoning: '' })).toEqual({ name: 'New', description: null, model: null, reasoning: null }); });
  it('agentChanges returns null for normalized no-op edits', () => { expect(agentChanges(agent, { ...valid, name: ' Name ' })).toBeNull(); });
  it('agentErrorProblems maps agent and indexed catalog paths to fields and retains unmatched problems', () => { expect(agentErrorProblems({ code: 'BAD', message: '', retryable: false, data: { problems: [{ path: 'agent.id', message: 'bad' }, { path: 'agents[3].reasoning', message: 'invalid' }, { path: 'catalog', message: 'broken' }, {}] } })).toEqual({ fields: { id: 'bad', reasoning: 'invalid' }, unmatched: ['catalog: broken'] }); });
});

describe('agent form boundary cases', () => {
  it('uses backend provider order and maps missing saved options to blank form values', () => {
    expect(emptyAgentForm([])).toEqual({ id: '', name: '', provider: '', model: '', reasoning: '', description: '' });
    expect(emptyAgentForm([providers[1], providers[0]]).provider).toBe('q');
    expect(editAgentForm({ id: 'a', name: 'Agent', provider: 'p' })).toEqual({ id: 'a', name: 'Agent', provider: 'p', model: '', reasoning: '', description: '' });
  });
  it('accepts exactly the supported model punctuation and rejects invalid starting characters', () => {
    expect(validateAgentForm({ ...valid, model: 'A0._:/@+-' }, 'create', [], providers)).toEqual({});
    const message = 'Use 1–128 letters, digits, or . _ : / @ + - characters, starting with a letter or digit.';
    for (const model of ['.model', '_model', ':model', '/model', '@model', '+model', '-model', 'model#x']) {
      expect(validateAgentForm({ ...valid, model }, 'create', [], providers).model).toBe(message);
    }
  });
  it('compares duplicate candidates case-sensitively and trims a truncated copy name', () => {
    expect(duplicateAgentId('agent', ['Agent-copy'])).toBe('agent-copy');
    expect(duplicateAgentForm({ ...agent, name: 'x'.repeat(73) + '   extra' }, []).name).toBe('x'.repeat(73) + ' copy');
  });
  it('validates trimmed boundaries and duplicate ids in both create modes', () => {
    for (const mode of ['create', 'duplicate'] as const) {
      expect(validateAgentForm({ ...valid, id: ' agent ' }, mode, ['agent'], providers).id).toBe('That agent id already exists.');
    }
    expect(validateAgentForm({ ...valid, id: 'agent' }, 'edit', ['agent'], providers)).toEqual({});
    for (const id of ['-bad', 'a'.repeat(65), 'a_b']) expect(validateAgentForm({ ...valid, id }, 'create', [], providers).id).toBeTruthy();
    for (const model of ['-bad', 'a'.repeat(129), 'bad model']) expect(validateAgentForm({ ...valid, model }, 'create', [], providers).model).toBeTruthy();
    expect(validateAgentForm({ ...valid, id: 'a'.repeat(64), name: 'n'.repeat(80), model: 'm'.repeat(128), description: 'd'.repeat(4000) }, 'create', [], providers)).toEqual({});
  });
  it('generates distinct truncated ids and copies every mutable setting', () => {
    const source = 'a'.repeat(58) + '------';
    const first = duplicateAgentId(source, []);
    const second = duplicateAgentId(source, [first]);
    expect(first).toBe('a'.repeat(58) + '-copy');
    expect(second).toBe('a'.repeat(57) + '-copy-2');
    expect(duplicateAgentForm({ ...agent, name: ' Name ' }, ['agent-copy'])).toEqual({ id: 'agent-copy-2', name: 'Name copy', provider: 'p', model: 'model', reasoning: 'high', description: 'desc' });
  });
  it('normalizes saved and edited values and preserves internal description whitespace', () => {
    expect(agentChanges({ ...agent, description: '  line  one\nline two  ' }, { ...valid, description: 'line  one\nline two' })).toBeNull();
    expect(agentChanges({ id: 'a', name: 'Name', provider: 'p' }, { id: 'different', name: ' Name ', provider: ' q ', model: ' new/model ', reasoning: ' high ', description: ' text\n  more ' })).toEqual({ provider: 'q', model: 'new/model', reasoning: 'high', description: 'text\n  more' });
  });
  it('ignores malformed problem entries and maps terminal fields only', () => {
    expect(agentErrorProblems({ code: 'BAD', message: 'bad', retryable: false, data: { problems: [null, 2, { path: 1, message: 'x' }, { path: 'agent.name', message: 2 }, { path: 'changes.model', message: 'bad model' }, { path: 'notname', message: 'other' }] } })).toEqual({ fields: { model: 'bad model' }, unmatched: ['notname: other'] });
  });
});
