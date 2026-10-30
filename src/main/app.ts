/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Electron Main Process Entry Point for StorePOS (Production Windows Desktop).
 * Features:
 * - Single-instance enforcement (prevents multiple processes touching SQLite)
 * - Safe persistent storage in Windows %APPDATA%/StorePOS/data (isolated from installer)
 * - Pre-creation of required folders: data, images, backups
 * - SQLite initialization with WAL mode, foreign keys, and synchronous=FULL durability
 * - Secure sandboxed IPC dispatcher (contextIsolation: true, sandbox: true)
 * - Offline asset loading from dist/index.html (no localhost or Express required in production)
 */

import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase, closeDatabase, getDataDirectory, getImagesDirectory, getBackupsDirectory } from './db/database.ts';
import { handleIpcMessage } from './ipc/handlers.ts';

let mainWindow: BrowserWindow | null = null;

// Enforce single-instance lock so store database is not accessed concurrently by multiple instances
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
    // 1. Resolve and prepare Windows userData persistent directories
    const userDataPath = app.getPath('userData');
    const dataDir = path.join(userDataPath, 'data');
    process.env.STORE_DATA_DIR = dataDir;

    const dbPath = path.join(dataDir, 'store.db');
    process.env.STORE_DB_PATH = dbPath;

    // Ensure required storage subdirectories exist
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const imagesDir = path.join(dataDir, 'images');
    if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
    const backupsDir = path.join(dataDir, 'backups');
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

    console.log(`[StorePOS Main] Initializing SQLite database at: ${dbPath}`);
    initDatabase(dbPath);

    // 2. Register secure IPC dispatcher
    ipcMain.handle('api:ipc', async (_event: any, req: any) => {
      return await handleIpcMessage(req);
    });

    // 3. Resolve preload script path
    const candidatePreloadPaths = [
      path.join(__dirname, 'preload.cjs'),
      path.join(__dirname, 'preload.js'),
      path.join(__dirname, '../dist-electron/preload.cjs'),
      path.join(app.getAppPath(), 'dist-electron', 'preload.cjs')
    ];
    const preloadPath = candidatePreloadPaths.find(p => fs.existsSync(p)) || candidatePreloadPaths[0];

    // Resolve app icon
    const candidateIconPaths = [
      path.join(app.getAppPath(), 'resources', 'icons', 'icon.ico'),
      path.join(__dirname, '../resources/icons/icon.ico'),
      path.join((process as any).resourcesPath || '', 'icons', 'icon.ico')
    ];
    const iconPath = candidateIconPaths.find(p => fs.existsSync(p));

    // 4. Create Windows Desktop Window (optimized for 1366x768 up to 4K displays)
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1280,
      minHeight: 720,
      title: 'StorePOS — ლოკალური მაღაზიის მართვა (Offline)',
      icon: iconPath,
      backgroundColor: '#020617', // slate-950
      autoHideMenuBar: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    });

    // Clean POS UI without generic browser menus
    mainWindow.setMenuBarVisibility(false);

    // 5. Load React Application
    if (process.env.VITE_DEV_SERVER_URL) {
      mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    } else {
      const candidateIndexPaths = [
        path.join(app.getAppPath(), 'dist', 'index.html'),
        path.join(__dirname, '../dist/index.html'),
        path.join((process as any).resourcesPath || '', 'app.asar', 'dist', 'index.html')
      ];
      const indexPath = candidateIndexPaths.find(p => fs.existsSync(p)) || candidateIndexPaths[0];
      console.log(`[StorePOS Main] Loading UI from: ${indexPath}`);
      mainWindow.loadFile(indexPath);
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
