import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRenderer, IpcRendererEvent } from 'electron';
import type { AgentStudioApi, ConnectionPayload, CreateArgs } from '../shared/api';

// A sandboxed preload may only require('electron'), so these are duplicated from main/ipc.ts (a test keeps them equal).
export const PRELOAD_CHANNELS = {
  list: 'workspaces:list',
  create: 'workspaces:create',
  pickFolder: 'workspaces:pickFolder',
  connectionGet: 'connection:get',
  connectionState: 'connection:state',
  dashboardTeams: 'dashboard:teams',
  dashboardBoard: 'dashboard:board',
  dashboardActivity: 'dashboard:activity',
  managementOverview: 'management:overview',
  managementAgents: 'management:agents',
  managementTeam: 'management:team',
  managementValidateTeam: 'management:validateTeam',
  managementBoardSettings: 'management:boardSettings',
  managementCreateAgent: 'management:createAgent',
  managementUpdateAgent: 'management:updateAgent',
  managementDeleteAgent: 'management:deleteAgent',
  managementCreateTeam: 'management:createTeam',
  managementRenameTeam: 'management:renameTeam',
  managementDeleteTeam: 'management:deleteTeam',
  managementAddMember: 'management:addMember',
  managementUpdateMember: 'management:updateMember',
  managementRemoveMember: 'management:removeMember',
  managementUpdateBoardSettings: 'management:updateBoardSettings',
  managementRoles: 'management:roles',
  managementCreateRole: 'management:createRole',
  managementUpdateRole: 'management:updateRole',
  managementUpdateRoleInstructions: 'management:updateRoleInstructions',
  managementDeleteRole: 'management:deleteRole',
  managementRunBoard: 'management:runBoard',
  managementStopBoard: 'management:stopBoard',
  managementSwitchMemberAgent: 'management:switchMemberAgent',
  managementResumeMemberAgent: 'management:resumeMemberAgent',
} as const;

type IpcRendererLike = Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>;

export function buildApi(ipc: IpcRendererLike): AgentStudioApi {
  return {
    workspaces: {
      list: () => ipc.invoke(PRELOAD_CHANNELS.list),
      create: (args: CreateArgs) => ipc.invoke(PRELOAD_CHANNELS.create, args),
      pickFolder: () => ipc.invoke(PRELOAD_CHANNELS.pickFolder),
    },
    dashboard: {
      teams: (id: string) => ipc.invoke(PRELOAD_CHANNELS.dashboardTeams, id),
      board: (id: string) => ipc.invoke(PRELOAD_CHANNELS.dashboardBoard, id),
      activity: (id: string) => ipc.invoke(PRELOAD_CHANNELS.dashboardActivity, id),
    },
    management: {
      overview: (w) => ipc.invoke(PRELOAD_CHANNELS.managementOverview, w, {}),
      agents: (w) => ipc.invoke(PRELOAD_CHANNELS.managementAgents, w, {}),
      team: (w, teamDefId) => ipc.invoke(PRELOAD_CHANNELS.managementTeam, w, { teamDefId }),
      validateTeam: (w, teamDefId) => ipc.invoke(PRELOAD_CHANNELS.managementValidateTeam, w, { teamDefId }),
      boardSettings: (w) => ipc.invoke(PRELOAD_CHANNELS.managementBoardSettings, w, {}),
      createAgent: (w, agent) => ipc.invoke(PRELOAD_CHANNELS.managementCreateAgent, w, { agent }),
      updateAgent: (w, agentDefId, changes) =>
        ipc.invoke(PRELOAD_CHANNELS.managementUpdateAgent, w, { agentDefId, changes }),
      deleteAgent: (w, agentDefId) => ipc.invoke(PRELOAD_CHANNELS.managementDeleteAgent, w, { agentDefId }),
      createTeam: (w, input) =>
        ipc.invoke(
          PRELOAD_CHANNELS.managementCreateTeam,
          w,
          input.teamDefId === undefined ? { name: input.name } : { name: input.name, teamDefId: input.teamDefId },
        ),
      renameTeam: (w, teamDefId, name) => ipc.invoke(PRELOAD_CHANNELS.managementRenameTeam, w, { teamDefId, name }),
      deleteTeam: (w, teamDefId) => ipc.invoke(PRELOAD_CHANNELS.managementDeleteTeam, w, { teamDefId }),
      addMember: (w, teamDefId, member) =>
        ipc.invoke(PRELOAD_CHANNELS.managementAddMember, w, { teamDefId, member }),
      updateMember: (w, teamDefId, memberId, changes) =>
        ipc.invoke(PRELOAD_CHANNELS.managementUpdateMember, w, { teamDefId, memberId, changes }),
      removeMember: (w, teamDefId, memberId) =>
        ipc.invoke(PRELOAD_CHANNELS.managementRemoveMember, w, { teamDefId, memberId }),
      updateBoardSettings: (w, changes, expectedSha256) =>
        ipc.invoke(
          PRELOAD_CHANNELS.managementUpdateBoardSettings,
          w,
          expectedSha256 === undefined ? { changes } : { changes, expectedSha256 },
        ),
      roles: (w) => ipc.invoke(PRELOAD_CHANNELS.managementRoles, w, {}),
      createRole: (w, input, expectedRolesSha256) =>
        ipc.invoke(PRELOAD_CHANNELS.managementCreateRole, w, { input, expectedRolesSha256 }),
      updateRole: (w, roleId, changes, expectedRolesSha256) =>
        ipc.invoke(PRELOAD_CHANNELS.managementUpdateRole, w, { roleId, changes, expectedRolesSha256 }),
      updateRoleInstructions: (w, roleId, text, expectedRolesSha256, expectedInstructionsSha256) =>
        ipc.invoke(PRELOAD_CHANNELS.managementUpdateRoleInstructions, w, { roleId, text, expectedRolesSha256, expectedInstructionsSha256 }),
      deleteRole: (w, roleId, confirmation) =>
        ipc.invoke(PRELOAD_CHANNELS.managementDeleteRole, w, { roleId, confirmation }),
      runBoard: (w, teamId) => ipc.invoke(PRELOAD_CHANNELS.managementRunBoard, w, { teamId }),
      switchMemberAgent: (w, teamDefId, memberId, agent, confirmation) =>
        ipc.invoke(PRELOAD_CHANNELS.managementSwitchMemberAgent, w, confirmation === undefined ? { teamDefId, memberId, agent } : { teamDefId, memberId, agent, confirmation }),
      resumeMemberAgent: (w, teamDefId, memberId, agent) => ipc.invoke(PRELOAD_CHANNELS.managementResumeMemberAgent, w, { teamDefId, memberId, agent }),
      stopBoard: (w) => ipc.invoke(PRELOAD_CHANNELS.managementStopBoard, w, {}),
    },
    connection: {
      onChange: (cb) => {
        let active = true;
        let pushed = false;
        const listener = (_event: IpcRendererEvent, s: ConnectionPayload) => {
          if (!active) return;
          pushed = true;
          cb(s);
        };
        ipc.on(PRELOAD_CHANNELS.connectionState, listener);
        void ipc.invoke(PRELOAD_CHANNELS.connectionGet).then(
          (s: ConnectionPayload) => {
            if (active && !pushed) cb(s);
          },
          () => {},
        );
        return () => {
          active = false;
          ipc.removeListener(PRELOAD_CHANNELS.connectionState, listener);
        };
      },
    },
  };
}

contextBridge.exposeInMainWorld('agentStudio', buildApi(ipcRenderer));
