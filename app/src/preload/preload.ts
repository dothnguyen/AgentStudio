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
