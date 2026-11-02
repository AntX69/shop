/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * In-memory session store. Tokens are random 256-bit values; nothing is persisted, so an
 * application restart ends every session.
 */

import crypto from 'node:crypto';
import { User, UserSession } from '../../shared/types.ts';

interface SessionRecord {
  user: User;
  createdAt: number;
  lastSeenAt: number;
}

/** A session unused for this long is dropped (the UI locks itself much earlier). */
export const SESSION_IDLE_MS = 60 * 60 * 1000;
/** No session outlives a working day. */
export const SESSION_MAX_AGE_MS = 16 * 60 * 60 * 1000;
// In-memory active sessions map: token -> session
const activeSessions = new Map<string, SessionRecord>();

export function getActiveSession(token: string, now: number = Date.now()): User | null {
  if (!token || typeof token !== 'string') return null;
  const s = activeSessions.get(token);
  if (!s) return null;
  if (now - s.lastSeenAt > SESSION_IDLE_MS || now - s.createdAt > SESSION_MAX_AGE_MS) {
    activeSessions.delete(token);
    return null;
  }
  s.lastSeenAt = now;
  return s.user;
}

export function createSession(user: User): UserSession {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  activeSessions.set(token, { user, createdAt: now, lastSeenAt: now });
  return { user, token };
}

export function revokeSession(token: string): void {
  activeSessions.delete(token);
}

export function revokeUserSessions(userId: number, exceptToken?: string): number {
  let n = 0;
  for (const [token, s] of activeSessions) {
    if (s.user.id === userId && token !== exceptToken) {
      activeSessions.delete(token);
      n++;
    }
  }
  return n;
}

/** Updates the cached user (role or name changed by the owner). */
export function refreshSessionUser(token: string, user: User): void {
  const record = activeSessions.get(token);
  if (record) record.user = user;
}

export function revokeAllSessions(): void {
  activeSessions.clear();
}
