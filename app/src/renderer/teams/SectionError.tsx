import type { JSX } from 'react';
import type { DashboardSectionController } from '../dashboard/useDashboardSection';

export interface SectionErrorProps {
  section: DashboardSectionController<unknown>;
  /** Names the failed source when several sources can fail independently. */
  label?: string;
  retryLabel?: string;
  retryId?: string;
  /** True when earlier data stays on screen while this source is failing. */
  stale?: boolean;
  /** False when another source already holds the single role=alert; the error stays visible. */
  alert?: boolean;
  onRetry?(): void;
}

/** The single renderer for a failed source: code: message, remediation and one Retry. */
export function SectionError(props: SectionErrorProps): JSX.Element | null {
  const { section, label, stale = false, alert = true } = props;
  if (section.error === null) return null;
  const remediation = typeof section.error.remediation === 'string' && section.error.remediation !== ''
    ? section.error.remediation
    : `Retry${label ? ` loading ${label.toLowerCase()}` : ''}; if it keeps failing, check the Agent Studio connection.`;
  return (
    <div className="panel-error" role={alert ? 'alert' : undefined}>
      {stale && <p>Showing previously loaded data.</p>}
      <p>{label ? `${label}: ` : ''}<code className="entity-id">{section.error.code}</code>: {section.error.message}</p>
      <p>{remediation}</p>
      <button type="button" id={props.retryId} onClick={() => { if (props.onRetry) props.onRetry(); else void section.reload(); }}>{props.retryLabel ?? 'Retry'}</button>
    </div>
  );
}
