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
 *
 * Hardening: no application menu, no DevTools in the packaged app, navigation and new windows
 * blocked, only the camera permission granted (for OCR), every http/https/ws request blocked
 * (the store data never leaves this computer), and IPC accepted only from the app's own page.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { initDatabase, closeDatabase } from './db/database.ts';
import { handleIpcMessage } from './ipc/handlers.ts';

let mainWindow: BrowserWindow | null = null;
let appPageUrl = '';

const devServerUrl = process.env.VITE_DEV_SERVER_URL || '';
const allowDevTools = !app.isPackaged || process.env.STOREPOS_DEVTOOLS === '1';

function stripHashAndQuery(url: string): string {
  return url.split('#')[0].split('?')[0];
}

function isAppPage(url: string): boolean {
  if (!url) return false;
  if (devServerUrl) return url.startsWith(devServerUrl);
  return stripHashAndQuery(url) === appPageUrl;
}

function applySessionHardening(): void {
  const ses = session.defaultSession;

  // Camera only (handwritten code OCR); microphone, location, notifications, etc. are refused.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const mediaTypes = (details as any)?.mediaTypes as string[] | undefined;
    const videoOnly = !mediaTypes || mediaTypes.every((t) => t === 'video');
    callback(permission === 'media' && videoOnly && isAppPage(wc.getURL()));
  });
  ses.setPermissionCheckHandler((wc, permission) => permission === 'media' && !!wc && isAppPage(wc.getURL()));

  // Offline by design: nothing may be fetched from or sent to the network.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const allowed = !!devServerUrl && details.url.startsWith(devServerUrl.replace(/\/$/, ''));
    if (!allowed) console.warn(`[StorePOS Main] Blocked network request: ${details.url}`);
    callback({ cancel: !allowed });
  });
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!isAppPage(url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAppPage(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (!allowDevTools) {
    contents.on('devtools-opened', () => contents.closeDevTools());
  }
});

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
    Menu.setApplicationMenu(null);
    applySessionHardening();

    // 1. Resolve and prepare Windows userData persistent directories
    const userDataPath = app.getPath('userData');
    const dataDir = path.join(userDataPath, 'data');
    process.env.STORE_DATA_DIR = dataDir;

    const dbPath = path.join(dataDir, 'store.db');
    process.env.STORE_DB_PATH = dbPath;

    try {
      // Ensure required storage subdirectories exist
      for (const dir of [dataDir, path.join(dataDir, 'images'), path.join(dataDir, 'backups')]) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      }
      console.log(`[StorePOS Main] Initializing SQLite database at: ${dbPath}`);
      initDatabase(dbPath);
    } catch (err: any) {
      console.error('[StorePOS Main] Database initialization failed:', err);
      dialog.showErrorBox(
        'StorePOS — მონაცემთა ბაზა ვერ გაიხსნა',
        `მონაცემთა ბაზის გახსნა ვერ მოხერხდა და პროგრამა დაიხურება. მონაცემები არ წაშლილა.\n\n` +
        `ბაზის ფაილი: ${dbPath}\nშეცდომა: ${err?.message || err}\n\n` +
        `სცადეთ კომპიუტერის გადატვირთვა. თუ შეცდომა მეორდება, ბოლო სარეზერვო ასლები ინახება საქაღალდეში:\n${path.join(dataDir, 'backups')}`
      );
      app.exit(1);
      return;
    }

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

    const candidateIndexPaths = [
      path.join(app.getAppPath(), 'dist', 'index.html'),
      path.join(__dirname, '../dist/index.html'),
      path.join((process as any).resourcesPath || '', 'app.asar', 'dist', 'index.html')
    ];
    const indexPath = candidateIndexPaths.find(p => fs.existsSync(p)) || candidateIndexPaths[0];
    appPageUrl = pathToFileURL(indexPath).href;

    // 2. Register secure IPC dispatcher: only the app's own page in the main window may call it.
    ipcMain.handle('api:ipc', async (event: any, req: any) => {
      const frame = event.senderFrame;
      const trusted = !!mainWindow && event.sender === mainWindow.webContents && !!frame && !frame.parent && isAppPage(frame.url);
      if (!trusted) {
        console.warn('[StorePOS Main] Rejected IPC from untrusted sender:', frame?.url);
        return { success: false, error: 'მოთხოვნა უარყოფილია' };
      }
      return await handleIpcMessage(req);
    });

    // 4. Create Windows Desktop Window. The layout adapts down to 1024x600 (e.g. 1366x768 at
    //    125% or 1920x1080 at 175% Windows scaling) and opens maximized, as a till should.
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1024,
      minHeight: 600,
      show: false,
      title: 'StorePOS — ლოკალური მაღაზიის მართვა (Offline)',
      icon: iconPath,
      backgroundColor: '#020617', // slate-950
      autoHideMenuBar: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        devTools: allowDevTools,
        spellcheck: false
      }
    });

    // Clean POS UI without generic browser menus
    mainWindow.setMenuBarVisibility(false);
    mainWindow.once('ready-to-show', () => {
      if (process.env.STOREPOS_NO_MAXIMIZE !== '1') mainWindow?.maximize();
      mainWindow?.show();
    });

    // 5. Load React Application
    if (devServerUrl) {
      mainWindow.loadURL(devServerUrl);
    } else {
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

  app.on('before-quit', () => {
    closeDatabase();
  });
}

