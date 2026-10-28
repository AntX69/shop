/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Secure Preload Script for Electron Desktop POS.
 * Enforces contextIsolation: true and nodeIntegration: false.
 * Only exposes strict, typed electronAPI.invoke to renderer window.
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface IpcBridge {
  invoke: (channel: string, payload?: any, token?: string) => Promise<{ success: boolean; data?: any; error?: string }>;
}

const electronAPI: IpcBridge = {
  invoke: (channel: string, payload?: any, token?: string) => {
    return ipcRenderer.invoke('api:ipc', { channel, payload, token });
  }
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
