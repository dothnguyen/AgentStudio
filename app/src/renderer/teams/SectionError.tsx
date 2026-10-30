import type { JSX } from 'react';
import type { DashboardSectionController } from '../dashboard/useDashboardSection';

export function SectionError(props: { section: DashboardSectionController<unknown> }): JSX.Element | null {
  const { section } = props;
  if (section.error === null) return null;
  return (
    <div className="panel-error" role="alert">
      <p><code className="entity-id">{section.error.code}</code>: {section.error.message}</p>
      {typeof section.error.remediation === 'string' && section.error.remediation !== '' && (
        <p>{section.error.remediation}</p>
      )}
      <button type="button" onClick={() => { void section.reload(); }}>Retry</button>
    </div>
  );
}
