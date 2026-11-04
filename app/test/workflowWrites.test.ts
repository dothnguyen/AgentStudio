import { describe, expect, it } from 'vitest';
import { MANAGEMENT_SPECS } from '../src/main/managementSpecs';

const sha = 'a'.repeat(64);
const uuid = '123e4567-e89b-42d3-a456-426614174000';
const cases: Array<[string, string, Record<string, unknown>, Record<string, unknown>, boolean]> = [
  ['saveBoardWorkflow', 'boardworkflow.save', { name: 'dev', definition: { title: 'Dev' }, expectedSha256: null, start: { allowed: true, default: false }, expectedBoardSha256: sha }, { name: 'dev', definition: { title: 'Dev' }, expectedSha256: null, start: { allowed: true, default: false }, expectedBoardSha256: sha }, false],
  ['deleteBoardWorkflow', 'boardworkflow.delete', { name: 'dev', expectedSha256: sha }, { name: 'dev', expectedSha256: sha }, false],
  ['savePrompt', 'prompt.save', { name: 'dev', text: 'hello', expectedSha256: null }, { name: 'dev', text: 'hello', expectedSha256: null }, false],
  ['deletePrompt', 'prompt.delete', { name: 'dev', expectedSha256: sha }, { name: 'dev', expectedSha256: sha }, false],
  ['addStatus', 'status.add', { id: 'ready', name: 'Ready', kind: 'none', expectedSha256: sha }, { id: 'ready', name: 'Ready', kind: 'none', expectedSha256: sha }, false],
  ['renameStatus', 'status.rename', { id: 'ready', name: 'Ready', expectedSha256: sha }, { id: 'ready', name: 'Ready', expectedSha256: sha }, false],
  ['removeStatus', 'status.remove', { id: 'ready', expectedSha256: sha }, { id: 'ready', expectedSha256: sha }, false],
  ['reorderStatuses', 'status.reorder', { ids: ['ready', 'done'], expectedSha256: sha }, { ids: ['ready', 'done'], expectedSha256: sha }, false],
  ['approveWorkflow', 'workflow.approve', { workflowRunId: uuid, stage: 'review', approve: false, note: 'revise' }, { workflowRunId: uuid, stage: 'review', approve: false, note: 'revise' }, true],
  // Matches T-204's backend contract in tests/unit/test_board_waiting_input.py::test_cli_passes_answer.
  ['answerAssignment', 'assignment.resolve', { assignmentId: uuid, answer: 'answer' }, { assignmentId: uuid, action: 'retry', answer: 'answer' }, true],
];

describe('workflow write specs', () => {
  it.each(cases)('%s sends exact backend arguments', (method, command, input, expected, mutating) => {
    const spec = MANAGEMENT_SPECS.find((s) => s.label === `management.${method}`)!;
    expect(spec.command).toBe(command);
    expect(spec.mutating).toBe(mutating);
    expect(spec.parse(input)).toEqual(expected);
    expect(typeof spec.parse({ ...input, workspace: '/other' })).toBe('string');
  });
  it('rejects missing and invalid concurrency tokens and malformed inputs', () => {
    const parse = (name: string, input: Record<string, unknown>) => MANAGEMENT_SPECS.find((s) => s.label === `management.${name}`)!.parse(input);
    expect(typeof parse('savePrompt', { name: 'dev', text: '' })).toBe('string');
    expect(typeof parse('deletePrompt', { name: 'dev', expectedSha256: null })).toBe('string');
    expect(typeof parse('saveBoardWorkflow', { name: 'dev', definition: {}, expectedSha256: null, start: null })).toBe('string');
    expect(typeof parse('reorderStatuses', { ids: ['a', 'a'], expectedSha256: sha })).toBe('string');
    expect(typeof parse('answerAssignment', { assignmentId: uuid, answer: ' ' })).toBe('string');
  });

  it('accepts the maximum assignment answer and rejects one character over', () => {
    const answerSpec = MANAGEMENT_SPECS.find((s) => s.label === 'management.answerAssignment')!;
    expect(answerSpec.parse({ assignmentId: uuid, answer: 'a'.repeat(16000) })).toEqual({
      assignmentId: uuid,
      action: 'retry',
      answer: 'a'.repeat(16000),
    });
    expect(typeof answerSpec.parse({ assignmentId: uuid, answer: 'a'.repeat(16001) })).toBe('string');
  });
});
