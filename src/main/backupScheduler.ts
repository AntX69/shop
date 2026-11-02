/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Application-level backup scheduler (Electron main process).
 * One automatic backup per Tbilisi calendar day, independent of who is logged in or which
 * screen is open: a first check shortly after start-up, then every 30 minutes, so a till
 * left running overnight still gets the next day's backup.
 */

import { BackupService } from './domain/backupService.ts';

export function startBackupScheduler(options: { firstRunDelayMs?: number; intervalMs?: number } = {}): () => void {
  const run = () => {
    try {
      new BackupService().runScheduledBackupIfDue();
    } catch (err) {
      console.error('[BackupScheduler] Scheduled backup check failed:', err);
    }
  };
  const first = setTimeout(run, options.firstRunDelayMs ?? 60_000);
  const timer = setInterval(run, options.intervalMs ?? 30 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
