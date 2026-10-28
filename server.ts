/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Express Full-Stack Server with Vite Middlewares.
 * Provides the local backend API bridge (/api/ipc) connected directly
 * to SQLite with WAL mode, foreign keys, and atomic transactions.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { initDatabase } from './src/main/db/database.ts';
import { handleIpcMessage } from './src/main/ipc/handlers.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // Initialize SQLite database
  initDatabase();

  app.use(express.json({ limit: '50mb' }));

  // Central IPC Bridge API endpoint for renderer
  app.post('/api/ipc', async (req, res) => {
    try {
      const response = await handleIpcMessage(req.body);
      res.json(response);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
    }
  });

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Setup Vite dev middleware in development mode
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // In production, serve static files from dist
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[StorePOS Server] Running at http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[StorePOS Server] Failed to start:', err);
  process.exit(1);
});
