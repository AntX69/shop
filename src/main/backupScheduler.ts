/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Application-level backup scheduler (Electron main process).
 * One automatic backup per Tbilisi calendar day, independent of who is logged in or which
 * screen is open: a first check shortly after start-up, then every 30 minutes, so a till
 * left running overnight still gets the next day's backup.
 *
 * Writing a backup keeps the main process busy for a moment (about 2 s for 30 MB of photos),
 * so a due backup waits until the till has been quiet for `idleMs` (no request from the
 * window), checking every `idleCheckMs`; after `maxDeferMs` it runs anyway.
 */

import { BackupService } from './domain/backupService.ts';
import { lastActivityAt } from './activity.ts';

export interface BackupSchedulerOptions {
  firstRunDelayMs?: number;
  intervalMs?: number;
  idleMs?: number;
  idleCheckMs?: number;
  maxDeferMs?: number;
  lastActivity?: () => number;
  service?: () => BackupService;
}

export function startBackupScheduler(options: BackupSchedulerOptions = {}): () => void {
  const idleMs = options.idleMs ?? 20_000;
  const idleCheckMs = options.idleCheckMs ?? 15_000;
  const maxDeferMs = options.maxDeferMs ?? 30 * 60_000;
  const lastActivity = options.lastActivity ?? lastActivityAt;
  const service = options.service ?? (() => new BackupService());
  let dueSince: number | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;

  const attempt = () => {
    waitTimer = null;
    try {
      const backup = service();
      if (!backup.isScheduledBackupDue()) {
        dueSince = null;
        return;
      }
      const now = Date.now();
      if (dueSince === null) dueSince = now;
      if (now - lastActivity() < idleMs && now - dueSince < maxDeferMs) {
        waitTimer = setTimeout(attempt, idleCheckMs); // the till is in use: wait for a quiet moment
        return;
      }
      backup.runScheduledBackupIfDue();
      dueSince = null;
    } catch (err) {
      console.error('[BackupScheduler] Scheduled backup check failed:', err);
    }
  };
  const first = setTimeout(attempt, options.firstRunDelayMs ?? 60_000);
  const timer = setInterval(() => { if (!waitTimer) attempt(); }, options.intervalMs ?? 30 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    if (waitTimer) clearTimeout(waitTimer);
  };
}
