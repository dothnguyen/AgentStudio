// @vitest-environment jsdom
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import {
  BOARDS_CAPTURE_TICKETS,
  BoardsCaptureApp,
  boardsCaptureMode,
  isBoardReady,
  isTicketReady,
  openBoardsSection,
} from '../capture/BoardsCaptureApp';
import {
  BOARDS_V1_TICKETS,
  boardsV1Overview,
  boardsV1Phases,
  boardsV1Settings,
  boardsV1TicketDetail,
  boardsV1TicketList,
  createBoardsV1Apis,
} from '../capture/boardsV1Fixture';

const appDir = path.join(__dirname, '..');
const designDir = path.join(appDir, '..', 'design', 'boards-v1');
const captureDir = path.join(designDir, 'captures');
const read = (absolutePath: string) => fs.readFileSync(absolutePath, 'utf8');

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.captureReady;
  delete document.documentElement.dataset.captureError;
});

function pngSize(file: string): { width: number; height: number } {
  const data = fs.readFileSync(file);
  expect([...data.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('boards v1 capture fixture', () => {
  it('matches the design sample board and ticket variants', () => {
    const list = boardsV1TicketList();
    expect(list.tickets).toHaveLength(16);
    expect(list.tickets.filter((ticket) => ticket.status === 'done')).toHaveLength(1);
    expect(list.tickets.find((ticket) => ticket.key === 'T-114')).toMatchObject({
      status: 'dev-ready', priority: 100, branch: 'ticket/t-114', rounds: { 'dev-ready': 2 },
    });
    expect(list.tickets.find((ticket) => ticket.key === 'T-118')).toMatchObject({ status: 'dev-ready', priority: 50 });
    expect(list.tickets.find((ticket) => ticket.key === 'T-136')).toMatchObject({ status: 'blocked', returnStatus: 'qa-ready' });
    expect(list.tickets.find((ticket) => ticket.key === 'T-112')).toMatchObject({ status: 'done' });

    expect(boardsV1Phases().currentPhase.name).toBe('Phase 06 - Roles, Routing and Skills redesign');
    expect(boardsV1Phases().phases[0]!.ticketCount).toBe(16);
    expect(boardsV1Settings().statuses.map((status) => status.id)).toContain('plan-merge-conflict');
    expect(boardsV1Overview().blockedTickets.map((ticket) => ticket.key)).toEqual(['T-136']);
  });

  it('has the working, waiting, blocked and done ticket pages', () => {
    expect(BOARDS_V1_TICKETS.map((ticket) => ticket.key)).toEqual(expect.arrayContaining(['T-114', 'T-118', 'T-136', 'T-112']));
    expect(boardsV1TicketDetail('T-114').ticket.title).toContain('Roles v2 (3/4)');
    expect(boardsV1TicketDetail('T-114').dependsOn).toEqual(['T-113']);
    expect(boardsV1TicketDetail('T-118').ticket.activity.state).toBe('not started');
    expect(boardsV1TicketDetail('T-136').ticket.status).toBe('blocked');
    expect(boardsV1TicketDetail('T-112').ticket.status).toBe('done');
  });

  it('keeps every capture write read-only', async () => {
    const { management } = createBoardsV1Apis();
    await expect(management.stopBoard('agent-studio')).resolves.toMatchObject({ ok: false, error: { code: 'CAPTURE_READ_ONLY' } });
    await expect(management.runBoard('agent-studio')).resolves.toMatchObject({ ok: false, error: { code: 'CAPTURE_READ_ONLY' } });
  });
});

describe('boards v1 capture app', () => {
  it('opens Current Phase in the real shell and marks the board ready', async () => {
    render(<BoardsCaptureApp />);
    await waitFor(() => expect(document.documentElement.dataset.captureReady).toBe('true'), { timeout: 5000 });

    expect(isBoardReady(document)).toBe(true);
    expect(document.querySelector('[data-section="boards/current"]')?.textContent).toContain('Phase 06 - Roles, Routing and Skills redesign');
    expect(document.querySelectorAll('[data-ticket-key]').length).toBeGreaterThan(0);
    expect(openBoardsSection(document)).toBe(true);
  });

  it('parses each capture view and maps it to its ticket key', () => {
    expect(boardsCaptureMode('')).toBe('board');
    expect(boardsCaptureMode('?view=board-all')).toBe('board-all');
    for (const mode of ['backlog', 'backlog-filtered', 'backlog-collapsed', 'phases']) expect(boardsCaptureMode(`?view=${mode}`)).toBe(mode);
    expect(boardsCaptureMode('?view=ticket-working')).toBe('ticket-working');
    expect(boardsCaptureMode('?view=unknown')).toBe('board');
    expect(BOARDS_CAPTURE_TICKETS).toEqual({
      'ticket-working': 'T-114',
      'ticket-waiting': 'T-118',
      'ticket-blocked': 'T-136',
      'ticket-done': 'T-112',
    });
  });

  it('checks readiness only when the real board or ticket heading is present', () => {
    const root = document.implementation.createHTMLDocument('capture');
    expect(isBoardReady(root)).toBe(false);
    expect(isTicketReady(root)).toBe(false);

    const board = root.createElement('div');
    board.setAttribute('data-section', 'boards/current');
    const lanes = root.createElement('div');
    lanes.className = 'boards-board-lanes';
    board.append(lanes);
    root.body.append(board);
    expect(isBoardReady(root)).toBe(true);

    const ticket = root.createElement('div');
    ticket.setAttribute('data-section', 'boards/ticket');
    const headingWrapper = root.createElement('div');
    headingWrapper.className = 'boards-ticket-heading';
    headingWrapper.append(root.createElement('h1'));
    ticket.append(headingWrapper);
    root.body.append(ticket);
    expect(isTicketReady(root)).toBe(true);
  });

  it('opens Boards only from an enabled sidebar button', () => {
    expect(openBoardsSection(document.createElement('div'))).toBe(false);

    const nav = document.createElement('div');
    nav.className = 'workspace-nav';
    const button = document.createElement('button');
    button.className = 'nav-item';
    const label = document.createElement('span');
    label.className = 'nav-label';
    label.textContent = 'Boards';
    button.append(label);
    nav.append(button);
    const root = document.createElement('div');
    root.append(nav);

    let clicks = 0;
    button.addEventListener('click', () => { clicks += 1; });
    expect(openBoardsSection(root)).toBe(true);
    expect(clicks).toBe(1);

    button.disabled = true;
    expect(openBoardsSection(root)).toBe(false);
    expect(clicks).toBe(1);
  });
});

describe('boards v1 capture evidence', () => {
  const names = ['board', 'board-all-columns', 'ticket-working', 'ticket-waiting', 'ticket-blocked', 'ticket-done'];
  const manifest = JSON.parse(read(path.join(captureDir, 'manifest.json'))) as {
    width: number;
    files: Record<string, { width: number; height: number; sha256: string }>;
  };

  it.each(names)('captures/%s.png is a real screenshot matching its checksum and the design size', (name) => {
    const file = path.join(captureDir, `${name}.png`);
    const design = path.join(designDir, `${name}.png`);
    expect(fs.existsSync(file), `${file} is missing`).toBe(true);
    expect(fs.statSync(file).size).toBeGreaterThan(10_000);
    expect(pngSize(file)).toEqual(pngSize(design));
    expect(manifest.files[`${name}.png`]).toMatchObject({ width: manifest.width, height: pngSize(file).height });
    expect(sha256(file)).toBe(manifest.files[`${name}.png`]!.sha256);
  });

  it('wires the capture command and documents the generated files', () => {
    const pkg = JSON.parse(read(path.join(appDir, 'package.json'))) as { scripts: Record<string, string> };
    expect(pkg.scripts['capture:boards']).toContain('electron dist/live/captureBoards.js');
    const capture = read(path.join(appDir, 'src/live/captureBoards.ts'));
    expect(capture).toContain("'design', 'boards-v1', 'captures'");
    for (const name of names) expect(capture).toContain(`file: '${name}.png'`);

    const readme = read(path.join(designDir, 'README.md'));
    expect(readme).toContain('npm --prefix app run capture:boards');
    for (const name of names) expect(readme).toContain(`captures/${name}.png`);
  });

  it('lists every deliberate difference from the design', () => {
    const readme = read(path.join(designDir, 'README.md'));
    for (const difference of [
      "the app's own sidebar",
      'real workspace values',
      'hides empty columns',
      'live component text',
      'Focus rings',
    ]) expect(readme, `README must list: ${difference}`).toContain(difference);
  });
});
