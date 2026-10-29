import { useId, useState, type JSX } from 'react';
import { moveRoleSkill, SKILL_ID_MESSAGE } from './roleEditModel';

export interface RoleSkillEditorProps {
  skills: readonly string[];
  availableSkills: readonly { id: string }[];
  disabled: boolean;
  error?: string;
  onChange(skills: string[]): void;
}

const SKILL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function RoleSkillEditor(props: RoleSkillEditorProps): JSX.Element {
  const uid = useId();
  const [manual, setManual] = useState('');
  const [picked, setPicked] = useState('');
  const [localError, setLocalError] = useState('');
  const available = new Set(props.availableSkills.map(s => s.id));
  const unused = props.availableSkills.filter(s => !props.skills.includes(s.id));
  const error = localError || props.error;
  const errorId = `${uid}-error`;

  const add = (raw: string, clear: () => void) => {
    const id = raw.trim().toLowerCase();
    if (!SKILL_RE.test(id)) { setLocalError(SKILL_ID_MESSAGE); return; }
    if (props.skills.includes(id)) { setLocalError(`Remove the duplicate skill id '${id}'.`); return; }
    setLocalError('');
    props.onChange([...props.skills, id]);
    clear();
  };

  return <fieldset className="roles-skills" aria-describedby={error ? errorId : undefined} data-field="skills" tabIndex={-1}>
    <legend>Configured skills</legend>
    {props.skills.length === 0 ? <p>No skills configured.</p> : <ol className="roles-skill-list" aria-label="Configured skills in order">
      {props.skills.map((id, i) => <li key={id} className="roles-skill-row">
        <code>{id}</code>
        {!available.has(id) && <span className="roles-skill-missing">Missing skill file</span>}
        <span className="roles-skill-actions">
          <button type="button" disabled={props.disabled || i === 0} onClick={() => props.onChange(moveRoleSkill(props.skills, i, -1))}>Move {id} up</button>
          <button type="button" disabled={props.disabled || i === props.skills.length - 1} onClick={() => props.onChange(moveRoleSkill(props.skills, i, 1))}>Move {id} down</button>
          <button type="button" disabled={props.disabled} onClick={() => { setLocalError(''); props.onChange(props.skills.filter((_, j) => j !== i)); }}>Remove {id}</button>
        </span>
      </li>)}
    </ol>}
    <div className="roles-skill-add">
      <div className="roles-field"><label htmlFor={`${uid}-pick`}>Available skill</label>
        <select id={`${uid}-pick`} value={picked} disabled={props.disabled || unused.length === 0} onChange={e => setPicked(e.target.value)}>
          <option value="">{unused.length === 0 ? 'No unused skills available' : 'Choose a skill'}</option>
          {unused.map(s => <option key={s.id} value={s.id}>{s.id}</option>)}
        </select></div>
      <button type="button" disabled={props.disabled || !picked} onClick={() => add(picked, () => setPicked(''))}>Add selected skill</button>
    </div>
    <div className="roles-skill-add">
      <div className="roles-field"><label htmlFor={`${uid}-manual`}>Skill id to add</label>
        <input id={`${uid}-manual`} value={manual} disabled={props.disabled} aria-invalid={error ? true : undefined} onChange={e => { setManual(e.target.value); setLocalError(''); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); add(manual, () => setManual('')); } }} /></div>
      <button type="button" disabled={props.disabled} onClick={() => add(manual, () => setManual(''))}>Add skill</button>
    </div>
    {error && <span className="roles-field-error" id={errorId}>{error}</span>}
  </fieldset>;
}
