/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Electron Main Process Entry Point.
 * Implements single-instance lock, userData directory resolution for SQLite,
 * security sandboxing, and registers the IPC dispatcher.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { initDatabase, closeDatabase } from './db/database.ts';
import { handleIpcMessage } from './ipc/handlers.ts';

let mainWindow: BrowserWindow | null = null;

// Enforce single-instance lock so store database is not accessed by multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // 1. Initialize SQLite Database in user data folder
    const userDataPath = app.getPath('userData');
    const dbPath = path.join(userDataPath, 'store.db');
    process.env.STORE_DB_PATH = dbPath;
    console.log(`[StorePOS Main] Initializing SQLite database at: ${dbPath}`);
    initDatabase(dbPath);

    // 2. Register IPC handler
    ipcMain.handle('api:ipc', async (_event: any, req: any) => {
      return await handleIpcMessage(req);
    });

    // 3. Create Windows Desktop Window (1366x768 minimum, optimized for 1920x1080)
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1280,
      minHeight: 720,
      title: 'StorePOS — ლოკალური მაღაზიის მართვა (Offline)',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    // In development or production load
    if (process.env.VITE_DEV_SERVER_URL) {
      mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    } else {
      mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
    }

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  });

  app.on('window-all-closed', () => {
    closeDatabase();
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
