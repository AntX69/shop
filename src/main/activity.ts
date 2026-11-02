/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * When the till was last used (any request from the window). The backup scheduler uses it to
 * run the daily backup in a quiet moment instead of in the middle of a sale.
 */

let lastActivity = 0;

export function noteActivity(now: number = Date.now()): void {
  lastActivity = now;
}

export function lastActivityAt(): number {
  return lastActivity;
}
