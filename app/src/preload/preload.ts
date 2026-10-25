import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRenderer, IpcRendererEvent } from 'electron';
import type { AgentStudioApi, CreateArgs } from '../shared/api';
import type { StateChange } from '../main/serveClient';

// A sandboxed preload may only require('electron'), so these are duplicated from main/ipc.ts (a test keeps them equal).
export const PRELOAD_CHANNELS = {
  list: 'workspaces:list',
  create: 'workspaces:create',
  pickFolder: 'workspaces:pickFolder',
  connectionGet: 'connection:get',
  connectionState: 'connection:state',
} as const;

type IpcRendererLike = Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>;

export function buildApi(ipc: IpcRendererLike): AgentStudioApi {
  return {
    workspaces: {
      list: () => ipc.invoke(PRELOAD_CHANNELS.list),
      create: (args: CreateArgs) => ipc.invoke(PRELOAD_CHANNELS.create, args),
      pickFolder: () => ipc.invoke(PRELOAD_CHANNELS.pickFolder),
    },
    connection: {
      onChange: (cb) => {
        let active = true;
        let pushed = false;
        const listener = (_event: IpcRendererEvent, s: StateChange) => {
          if (!active) return;
          pushed = true;
          cb(s);
        };
        ipc.on(PRELOAD_CHANNELS.connectionState, listener);
        void ipc.invoke(PRELOAD_CHANNELS.connectionGet).then(
          (s: StateChange) => {
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
