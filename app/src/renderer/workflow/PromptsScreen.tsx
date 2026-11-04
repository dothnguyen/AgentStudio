import { useEffect, useRef, useState, type JSX } from 'react';
import type { ManagementApi, PromptDetail, Workspace } from '../api';
import { detectPlaceholders, groupPrompts, insertPlaceholder, PLACEHOLDERS, tokenCount, usedBy, wordCount } from './promptsModel';

export function PromptsScreen({ workspace, management }: { workspace: Workspace; management: ManagementApi }): JSX.Element {
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
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    void management.prompts(workspace.id).then(result => {
      if (cancelled) return;
      if (!result.ok) { setError('Could not load prompts.'); return; }
      setPrompts(result.data.prompts);
      setSelected(result.data.prompts[0]?.name ?? null);
    }).catch(() => { if (!cancelled) setError('Could not load prompts.'); }).finally(() => { if (!cancelled) setLoading(false); });
    void management.boardWorkflows(workspace.id).then(result => {
      if (!cancelled && result.ok) setTitles(Object.fromEntries(result.data.workflows.map(w => [w.name, w.title])));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [management, workspace.id]);
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
  function rows(items: PromptDetail[]): JSX.Element[] {
    return items.map(item => <button type="button" key={item.name} className={`prompt-row${selected === item.name ? ' selected' : ''}`} onClick={() => setSelected(item.name)} aria-pressed={selected === item.name}>
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
    <header className="prompts-header"><h1>Workflow prompts</h1><p>The instructions an agent gets for one agent step of a workflow. Placeholders such as the ticket text are filled in when the step starts. Files live in <code>.agent-studio/workflows/prompts/</code>.</p></header>
    <div className="prompts-layout"><section className="prompts-list" aria-label="Prompts">
      <div className="prompts-list-header"><h2>Prompts</h2><input aria-label="Filter prompts" placeholder="Filter prompts" value={filter} onChange={e => setFilter(e.target.value)} /></div>
      {loading ? <p className="prompts-message">Loading prompts…</p> : error ? <p className="prompts-message" role="alert">{error}</p> : <><div className="prompt-group">Board prompts ({groups.board.length})</div>{rows(groups.board)}<button type="button" className="prompt-other" aria-expanded={otherOpen} onClick={() => setOtherOpen(!otherOpen)}>{otherOpen ? '▾' : '▸'} Other prompts ({groups.other.length})</button>{otherOpen && rows(groups.other)}{prompts.length === 0 && <p className="prompts-message">No prompts found.</p>}</>}
    </section><section className="prompt-editor" aria-label="Prompt editor">
      {detailLoading ? <p className="prompts-message">Loading prompt…</p> : detailError ? <p className="prompts-message" role="alert">{detailError}</p> : detail ? <><div className="prompt-editor-header"><h2>{detail.name}.md</h2><div className="prompt-users">Used by {detail.users.length ? detail.users.map((user, i) => <span key={`${user.workflow}-${user.step}-${i}`}>{usedBy([user], titles)}</span>) : 'No workflow steps'}</div></div>
        <div className="prompt-placeholders"><span>Insert placeholder</span>{Object.entries(PLACEHOLDERS).map(([name, description]) => <button type="button" key={name} title={description} className={placeholders.used.includes(name) ? 'used' : ''} onClick={() => insert(name)}>{`{{${name}}}`}</button>)}</div>
        <textarea ref={editor} aria-label="Prompt text" value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
        <div className="prompt-footer"><span>{wordCount(text)} words · about {tokenCount(text)} tokens</span><span className={placeholders.unknown.length ? 'prompt-invalid' : 'prompt-valid'}>{placeholders.unknown.length ? `Unknown placeholders: ${placeholders.unknown.map(n => `{{${n}}}`).join(', ')}` : 'Placeholders OK'}</span>{text !== detail.text && <span className="prompt-unsaved">Unsaved changes</span>}</div></> : <p className="prompts-message">Select a prompt to edit.</p>}
    </section></div>
  </div>;
}
