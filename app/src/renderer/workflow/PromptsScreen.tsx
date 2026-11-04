import { useEffect, useRef, useState, type JSX } from 'react';
import type { ManagementApi, PromptDetail, Workspace } from '../api';
import { detectPlaceholders, groupPrompts, insertPlaceholder, PLACEHOLDERS, tokenCount, usedBy, wordCount } from './promptsModel';
import { Dialog } from '../teams/Dialog';

export function PromptsScreen({ workspace, management, initialPrompt, onDirtyChange }: { workspace: Workspace; management: ManagementApi; initialPrompt?: string | null; onDirtyChange?: (dirty: boolean) => void }): JSX.Element {
  const [prompts, setPrompts] = useState<PromptDetail[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PromptDetail | null>(null);
  const [text, setText] = useState('');
  const [filter, setFilter] = useState('');
  const [otherOpen, setOtherOpen] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [dialog, setDialog] = useState<'new' | 'delete' | null>(null);
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [pending, setPending] = useState(false);
  const [writeError, setWriteError] = useState('');
  const [conflict, setConflict] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const dirty = detail !== null && text !== detail.text;
  useEffect(() => {
    onDirtyChange?.(dirty);
    function beforeUnload(event: BeforeUnloadEvent): void { if (dirty) { event.preventDefault(); event.returnValue = ''; } }
    window.addEventListener('beforeunload', beforeUnload);
    return () => { onDirtyChange?.(false); window.removeEventListener('beforeunload', beforeUnload); };
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    void management.prompts(workspace.id).then(result => {
      if (cancelled) return;
      if (!result.ok) { setError('Could not load prompts.'); return; }
      setPrompts(result.data.prompts);
      setSelected(result.data.prompts.find(prompt => prompt.name === initialPrompt)?.name ?? result.data.prompts[0]?.name ?? null);
    }).catch(() => { if (!cancelled) setError('Could not load prompts.'); }).finally(() => { if (!cancelled) setLoading(false); });
    void management.boardWorkflows(workspace.id).then(result => {
      if (!cancelled && result.ok) setTitles(Object.fromEntries(result.data.workflows.map(w => [w.name, w.title])));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [initialPrompt, management, workspace.id]);
  useEffect(() => {
    if (selected === null) return;
    let cancelled = false;
    setDetail(null); setDetailError(''); setDetailLoading(true);
    void management.prompt(workspace.id, selected).then(result => {
      if (cancelled) return;
      if (!result.ok) { setDetailError('Could not load prompt.'); return; }
      setDetail(result.data); setText(result.data.text);
    }).catch(() => { if (!cancelled) setDetailError('Could not load prompt.'); }).finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [management, workspace.id, selected]);
  const groups = groupPrompts(prompts, filter);
  const placeholders = detectPlaceholders(text);
  const validName = /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
  const exists = prompts.some(prompt => prompt.name === name);
  function openNew(copy: boolean): void { setName(''); setSource(copy ? detail?.name ?? '' : ''); setWriteError(''); setDialog('new'); }
  function select(name: string): void {
    if (name === selected || pending) return;
    if (dirty && !window.confirm('Discard unsaved prompt changes?')) return;
    setConflict(false); setWriteError(''); setSelected(name);
  }
  async function save(name: string, value: string, sha: string | null): Promise<void> {
    setPending(true); setWriteError('');
    try {
      const result = await management.savePrompt(workspace.id, { name, text: value, expectedSha256: sha });
      if (!result.ok) { setConflict(result.error.code === 'CONFIG_CHANGED' && sha !== null); setWriteError(result.error.code === 'CONFIG_CHANGED' && sha !== null ? 'Changed elsewhere - reload' : result.error.message); return; }
      const saved = result.data;
      setPrompts(current => [...current.filter(p => p.name !== saved.name), saved].sort((a, b) => a.name.localeCompare(b.name)));
      setDetail(saved); setText(saved.text); setConflict(false); setDialog(null);
      if (selected !== saved.name) { setSelected(saved.name); setOtherOpen(true); }
    } catch { setWriteError('Could not save prompt.'); } finally { setPending(false); }
  }
  async function reload(): Promise<void> {
    if (!detail || pending) return;
    setPending(true); setWriteError('');
    try {
      const result = await management.prompt(workspace.id, detail.name);
      if (!result.ok) { setWriteError(result.error.message); return; }
      setDetail(result.data); setText(result.data.text); setPrompts(current => current.map(p => p.name === result.data.name ? result.data : p)); setConflict(false);
    } catch { setWriteError('Could not reload prompt.'); } finally { setPending(false); }
  }
  async function remove(): Promise<void> {
    if (!detail) return;
    setPending(true); setWriteError('');
    try {
      const result = await management.deletePrompt(workspace.id, { name: detail.name, expectedSha256: detail.sha256 });
      if (!result.ok) { setWriteError(result.error.message); return; }
      const remaining = prompts.filter(p => p.name !== detail.name);
      setPrompts(remaining); setDetail(null); setText(''); setSelected(remaining[0]?.name ?? null); setDialog(null);
    } catch { setWriteError('Could not delete prompt.'); } finally { setPending(false); }
  }
  function rows(items: PromptDetail[]): JSX.Element[] {
    return items.map(item => <button type="button" key={item.name} className={`prompt-row${selected === item.name ? ' selected' : ''}`} onClick={() => select(item.name)} aria-pressed={selected === item.name}>
      <span className="prompt-row-top"><span className="prompt-filename">{item.name}.md</span><span>{item.words} words</span></span>
      <span>{usedBy(item.users, titles) || 'Not used by any workflow'}</span>
    </button>);
  }
  function insert(name: string): void {
    const element = editor.current;
    if (!element) return;
    const result = insertPlaceholder(text, name, element.selectionStart, element.selectionEnd);
    setText(result.text);
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(result.cursor, result.cursor); });
  }
  return <div className="prompts-screen" data-section="workflow/prompts">
    <header className="prompts-header"><div><h1>Workflow prompts</h1><p>The instructions an agent gets for one agent step of a workflow. Placeholders such as the ticket text are filled in when the step starts. Files live in <code>.agent-studio/workflows/prompts/</code>.</p></div><button className="dialog-action dialog-action-primary" disabled={loading || pending} onClick={() => openNew(false)}>+ New prompt</button></header>
    <div className="prompts-layout"><section className="prompts-list" aria-label="Prompts">
      <div className="prompts-list-header"><h2>Prompts</h2><input aria-label="Filter prompts" placeholder="Filter prompts" value={filter} onChange={e => setFilter(e.target.value)} /></div>
      {loading ? <p className="prompts-message">Loading prompts…</p> : error ? <p className="prompts-message" role="alert">{error}</p> : <><div className="prompt-group">Board prompts ({groups.board.length})</div>{rows(groups.board)}<button type="button" className="prompt-other" aria-expanded={otherOpen} onClick={() => setOtherOpen(!otherOpen)}>{otherOpen ? '▾' : '▸'} Other prompts ({groups.other.length})</button>{otherOpen && rows(groups.other)}{prompts.length === 0 && <p className="prompts-message">No prompts found.</p>}</>}
    </section><section className="prompt-editor" aria-label="Prompt editor">
      {detailLoading ? <p className="prompts-message">Loading prompt…</p> : detailError ? <p className="prompts-message" role="alert">{detailError}</p> : detail ? <><div className="prompt-editor-header"><div><h2>{detail.name}.md</h2><div className="prompt-users">Used by {detail.users.length ? detail.users.map((user, i) => <span key={`${user.workflow}-${user.step}-${i}`}>{usedBy([user], titles)}</span>) : 'No workflow steps'}</div></div><div className="prompt-actions"><button className="dialog-action dialog-action-secondary" disabled={pending} onClick={() => openNew(true)}>Duplicate</button><span title={detail.users.length ? `Used by ${usedBy(detail.users, titles)}` : undefined}><button className="dialog-action dialog-action-secondary" disabled={pending || detail.users.length > 0} onClick={() => { setWriteError(''); setDialog('delete'); }}>Delete</button></span></div></div>
        <div className="prompt-placeholders"><span>Insert placeholder</span>{Object.entries(PLACEHOLDERS).map(([name, description]) => <button type="button" key={name} title={description} className={placeholders.used.includes(name) ? 'used' : ''} onClick={() => insert(name)}>{`{{${name}}}`}</button>)}</div>
        <textarea ref={editor} aria-label="Prompt text" value={text} onChange={e => setText(e.target.value)} spellCheck={false} disabled={pending} />
        {writeError && !dialog && <div className="prompts-message" role="alert">{writeError} {conflict && <button onClick={() => void reload()} disabled={pending}>Reload</button>}</div>}
        <div className="prompt-footer"><span>{wordCount(text)} words · about {tokenCount(text)} tokens</span><span className={placeholders.unknown.length ? 'prompt-invalid' : 'prompt-valid'}>{placeholders.unknown.length ? `Unknown placeholders: ${placeholders.unknown.map(n => `{{${n}}}`).join(', ')}` : 'Placeholders OK'}</span>{dirty && <span className="prompt-unsaved">Unsaved changes</span>}<div className="prompt-actions"><button className="dialog-action dialog-action-secondary" disabled={!dirty || pending} onClick={() => { setText(detail.text); if (!conflict) setWriteError(''); }}>Revert</button><button className="dialog-action dialog-action-primary" disabled={!dirty || pending || conflict} onClick={() => void save(detail.name, text, detail.sha256)}>Save prompt</button></div><p>Saved changes apply to steps that start afterwards; runs already in progress keep the prompt they started with.</p></div></> : <p className="prompts-message">Select a prompt to edit.</p>}
    </section></div>
    {dialog === 'new' && <Dialog title="New prompt" subtitle="Instructions for one agent step of a workflow." width={560} busy={pending} onClose={() => setDialog(null)} actions={[{ label: 'Cancel', onClick: () => setDialog(null) }, { label: 'Create and edit', variant: 'primary', disabled: !validName || exists || (source !== '' && !prompts.some(p => p.name === source)), onClick: () => { if (dirty && !window.confirm('Discard unsaved prompt changes?')) return; void save(name, source ? prompts.find(p => p.name === source)!.text : '{{task}}', null); } }]}>
      <div className="prompt-dialog-fields"><label>Name <span className="prompt-name-input"><input autoFocus value={name} onChange={e => setName(e.target.value)} aria-label="Name" /> <span>.md</span></span></label><small>Lowercase letters, numbers and hyphens, starting with a letter or number (up to 64 characters).</small>{name && !validName && <p role="alert">Enter a valid name.</p>}{exists && <p role="alert">A prompt with this name already exists.</p>}<span>Start from</span><label className="prompt-source"><input type="radio" name="source" checked={source === ''} onChange={() => setSource('')} /> Blank <small>Only the ticket placeholder, ready to write.</small></label><label className="prompt-source"><input type="radio" name="source" checked={source !== ''} disabled={!prompts.length} onChange={() => setSource(detail?.name ?? prompts[0]?.name ?? '')} /> A copy of <select aria-label="Copy prompt" value={source} disabled={source === ''} onChange={e => setSource(e.target.value)}>{source === '' && <option value="">Select prompt</option>}{prompts.map(p => <option key={p.name} value={p.name}>{p.name}.md</option>)}</select></label><p>A new prompt is not used until an agent step picks it in Routing › Edit workflow.</p>{writeError && <p role="alert">{writeError}</p>}</div>
    </Dialog>}
    {dialog === 'delete' && detail && <Dialog role="alertdialog" title={`Delete ${detail.name}.md?`} subtitle="No workflow step uses this prompt." width={560} busy={pending} onClose={() => setDialog(null)} actions={[{ label: 'Cancel', onClick: () => setDialog(null) }, { label: 'Delete prompt', variant: 'danger', onClick: () => void remove() }]}><p>The file is removed from <code>.agent-studio/workflows/prompts/</code>. You can get it back from git history.</p>{writeError && <p role="alert">{writeError}</p>}</Dialog>}
  </div>;
}
