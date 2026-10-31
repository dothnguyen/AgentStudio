import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type RefObject } from 'react';
import type { OverviewTeam } from '../api';
import { Icon } from '../icons/Icon';
import { TeamNameForm } from './TeamEditForms';
import { canEditTeam, uneditableNote, type TeamWrites } from './teamEditModel';
import { RUNTIME_LABELS, definitionMetaText, runtimeTone, shortRuntimeId, teamLabel } from './teamsModel';

export interface TeamPageHeaderProps {
  team: OverviewTeam | null;
  busy: boolean;
  refreshRef: RefObject<HTMLButtonElement | null>;
  onRefresh(): void;
  writes: Pick<TeamWrites, 'rename' | 'deleteTeam'>;
  pending: boolean;
  readOnly: boolean;
}

const COPY_STATUS_MS = 3000;

function svgProps(size: number): Record<string, string | number> {
  return { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' };
}

export function TeamPageHeader(props: TeamPageHeaderProps): JSX.Element {
  const { team, writes, pending } = props;
  const writeBlocked = pending || props.readOnly;
  const [teamForm, setTeamForm] = useState<'rename' | 'delete' | null>(null);
  const [open, setOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const renameRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const itemRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const confirmed = useRef(false);
  const wasPending = useRef(pending);
  const restoreFocus = useRef<'rename' | 'menu' | null>(null);
  const focusItem = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelForm = (invoker: 'rename' | 'menu'): void => {
    restoreFocus.current = invoker;
    setTeamForm(null);
  };
  useEffect(() => {
    if (teamForm !== null || restoreFocus.current === null) return;
    (restoreFocus.current === 'rename' ? renameRef : menuButtonRef).current?.focus();
    restoreFocus.current = null;
  }, [teamForm]);
  // A failed delete leaves the confirmation open: return focus to the Confirm button that pending disabled.
  useEffect(() => {
    if (wasPending.current && !pending && confirmed.current && confirmRef.current?.isConnected) { confirmed.current = false; confirmRef.current.focus(); }
    wasPending.current = pending;
  }, [pending]);
  useEffect(() => { if (writeBlocked) setOpen(false); }, [writeBlocked]);
  useEffect(() => {
    if (open && focusItem.current) { focusItem.current = false; itemRef.current?.focus(); }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: Event): void => {
      if (!menuWrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);
  useEffect(() => () => { if (copyTimer.current !== null) clearTimeout(copyTimer.current); }, []);

  function openMenu(): void {
    focusItem.current = true;
    if (open) { focusItem.current = false; itemRef.current?.focus(); return; }
    setOpen(true);
  }
  function onMenuButtonKey(e: KeyboardEvent<HTMLButtonElement>): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMenu();
    }
  }
  function onItemKey(e: KeyboardEvent<HTMLButtonElement>): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') e.preventDefault();
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); menuButtonRef.current?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  }
  function chooseDelete(): void {
    if (team === null || !canEditTeam(team)) return;
    setOpen(false);
    setTeamForm('delete');
  }
  function announceCopy(text: string): void {
    setCopyStatus(text);
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => { copyTimer.current = null; setCopyStatus(null); }, COPY_STATUS_MS);
  }
  function copyRuntimeId(id: string): void {
    if (copyTimer.current !== null) { clearTimeout(copyTimer.current); copyTimer.current = null; }
    setCopyStatus(null);
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard) { announceCopy('Runtime id could not be copied.'); return; }
    let written: Promise<void>;
    try { written = Promise.resolve(clipboard.writeText(id)); } catch { announceCopy('Runtime id could not be copied.'); return; }
    written.then(() => announceCopy('Runtime id copied'), () => announceCopy('Runtime id could not be copied.'));
  }

  const runtimeId = team?.runtime.teamId ?? null;
  const definition = team === null ? null : definitionMetaText(team);
  const editable = team !== null && canEditTeam(team);
  const reason = team === null ? null : uneditableNote(team);
  const metaItems: JSX.Element[] = [];
  if (team !== null && definition !== null) {
    if (team.id !== null) {
      metaItems.push(
        <span key="id" className="teams-page-meta-item">
          <span className="teams-page-meta-label">Team id</span>
          <code className="teams-page-chip">{team.id}</code>
        </span>,
      );
    }
    if (runtimeId !== null) {
      metaItems.push(
        <span key="runtime" className="teams-page-meta-item">
          <span className="teams-page-meta-label">Runtime</span>
          <code className="teams-page-mono" title={runtimeId}>{shortRuntimeId(runtimeId)}</code>
          <button type="button" className="teams-page-copy" aria-label="Copy runtime id" onClick={() => copyRuntimeId(runtimeId)}>
            <svg {...svgProps(13)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a1 1 0 0 1 1-1h10" />
            </svg>
          </button>
          {copyStatus !== null && <span role="status" className="teams-page-copy-status">{copyStatus}</span>}
        </span>,
      );
    }
    metaItems.push(
      <span key="definition" className="teams-page-meta-item">
        {definition.tone === 'ok' ? (
          <svg {...svgProps(13)} className="teams-page-check" fill="none" stroke="#6fd38b" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5L20 7" />
          </svg>
        ) : <Icon name="warning" size={13} className="teams-page-warning-icon" />}
        {definition.text}
      </span>,
    );
  }

  return (
    <header className="teams-page-header">
      <nav className="breadcrumb teams-page-breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li>Workspace</li>
          {team === null ? <li aria-current="page">Teams</li> : (
            <>
              <li>Teams</li>
              <li aria-current="page">{teamLabel(team)}</li>
            </>
          )}
        </ol>
      </nav>
      <div className="teams-page-heading-row">
        <div className="teams-page-identity">
          <div className="teams-page-title-row">
            {team === null ? <h1>Teams</h1> : <h1 id="teams-detail-title" tabIndex={-1}>{teamLabel(team)}</h1>}
            {team !== null && (
              <span className={`teams-page-pill teams-page-pill-${runtimeTone(team.runtime.state)}`}>
                <span className="status-dot" aria-hidden="true" />
                {RUNTIME_LABELS[team.runtime.state] ?? team.runtime.state}
              </span>
            )}
          </div>
          {team !== null && (
            <div className="teams-page-meta">
              {metaItems.flatMap((item, i) => (i === 0 ? [item] : [<span key={`d${i}`} className="teams-page-meta-divider" aria-hidden="true" />, item]))}
            </div>
          )}
        </div>
        <div className="teams-page-actions">
          <button type="button" className="teams-page-icon-button" aria-label="Refresh" aria-busy={props.busy} ref={props.refreshRef} onClick={props.onRefresh}>
            <svg {...svgProps(15)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 11a8 8 0 1 0-2.3 5.7" />
              <path d="M20 4v7h-7" />
            </svg>
          </button>
          {team !== null && editable && (
            <button type="button" className="teams-page-button" aria-label="Rename team" ref={renameRef} disabled={writeBlocked} onClick={() => setTeamForm('rename')}>Rename</button>
          )}
          {team !== null && (
            <div className="teams-page-menu" ref={menuWrapRef}>
              <button
                type="button"
                id="teams-page-menu-button"
                className="teams-page-icon-button"
                aria-label="More team actions"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? 'teams-page-menu' : undefined}
                ref={menuButtonRef}
                disabled={writeBlocked}
                onClick={() => { if (open) setOpen(false); else { focusItem.current = true; setOpen(true); } }}
                onKeyDown={onMenuButtonKey}
              >
                <svg {...svgProps(16)} fill="currentColor">
                  <circle cx="5" cy="12" r="1.6" />
                  <circle cx="12" cy="12" r="1.6" />
                  <circle cx="19" cy="12" r="1.6" />
                </svg>
              </button>
              {open && (
                <div className="teams-page-menu-popover">
                  <ul role="menu" id="teams-page-menu" aria-labelledby="teams-page-menu-button">
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        ref={itemRef}
                        aria-disabled={editable ? undefined : 'true'}
                        aria-describedby={editable ? undefined : 'teams-page-menu-reason'}
                        onKeyDown={onItemKey}
                        onClick={chooseDelete}
                      >
                        Delete team
                      </button>
                    </li>
                  </ul>
                  {!editable && reason !== null && <p id="teams-page-menu-reason" className="teams-page-menu-reason">{reason}</p>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {team !== null && teamForm === 'rename' && (
        <TeamNameForm
          headingLevel={2}
          heading="Rename team"
          submitLabel="Save name"
          initialName={team.name ?? ''}
          pending={pending}
          readOnly={props.readOnly}
          onSubmit={(name) => { void writes.rename(team, name).then((ok) => { if (ok) setTeamForm(null); }); }}
          onCancel={() => cancelForm('rename')}
        />
      )}
      {team !== null && teamForm === 'delete' && (
        <div className="teams-confirm" role="group" aria-label="Confirm team deletion">
          <p>{`Delete team "${teamLabel(team)}"? Its definition file is removed.`}</p>
          <button
            type="button"
            ref={confirmRef}
            disabled={writeBlocked}
            onClick={() => { confirmed.current = true; void writes.deleteTeam(team).then((ok) => { if (ok) setTeamForm(null); }); }}
          >
            Confirm delete
          </button>
          <button type="button" onClick={() => cancelForm('menu')}>Cancel</button>
        </div>
      )}
    </header>
  );
}
