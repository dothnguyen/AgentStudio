import { useEffect, useState } from 'react';
import type { ManagementApi, OverviewMember, OverviewTeam } from '../api';
import { thrownError, type TicketPermissionState } from './teamEditModel';

export interface TicketPermissionInput {
  workspaceId: string;
  management: ManagementApi;
  team: OverviewTeam;
  member: OverviewMember;
  /** Changes after every successful team write, so a save reloads the permission. */
  savedRevision: number;
  /** Bump to retry after a failed read. */
  retry: number;
}

/**
 * Reads the member's `canAddTickets` from the saved team definition. Runtime-only
 * members and members without an id have no saved permission (`null`), which the
 * UI shows as unknown and never sends back in a change.
 */
export function useTicketPermission(props: TicketPermissionInput): TicketPermissionState {
  const { workspaceId, management, team, member, savedRevision, retry } = props;
  const [permission, setPermission] = useState<TicketPermissionState>({ state: 'loading' });
  useEffect(() => {
    if (team.id === null || member.memberId === null || member.source === 'runtime') { setPermission({ state: 'ready', canAddTickets: null }); return; }
    let cancelled = false;
    void (async () => {
      let result;
      try { result = await management.team(workspaceId, team.id!); } catch (reason) { result = { ok: false as const, error: thrownError(reason) }; }
      if (cancelled) return;
      if (!result.ok) setPermission({ state: 'error', error: result.error });
      else {
        const raw = result.data.team.members.find(m => m.id === member.memberId);
        setPermission({ state: 'ready', canAddTickets: raw === undefined ? null : raw.canAddTickets === true });
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, team.id, member.memberId, member.source, savedRevision, retry]);
  return permission;
}
