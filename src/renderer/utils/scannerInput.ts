/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * USB barcode scanners work as a keyboard (HID "keyboard wedge"): they type the code very fast
 * and usually finish with Enter (or Tab). ScanDetector tells such a burst apart from a person
 * typing, so that on the sales screen a scan is always handled as a scan:
 * - wherever the focus is (a cart button, the quantity box of an open dialog...): the scanner's
 *   Enter never presses a button and its digits never land in another field;
 * - characters are read from the physical key (KeyboardEvent.code), so the Windows keyboard
 *   layout (Georgian, Russian, English) and NumLock do not change the code;
 * - leading zeros are kept (the code stays text);
 * - a doubled suffix (CR+LF) is swallowed; a scanner without a suffix is handled after a pause.
 *
 * Timing: scanners send a character every ~1-25 ms; a person needs ~100 ms or more per key and
 * never types SCAN_MIN_LENGTH characters at under SCAN_MAX_GAP_MS each. Held-down keys
 * (auto-repeat) are not scans. The detector is pure (time is passed in) so it is unit tested.
 */

export const SCAN_MAX_GAP_MS = 50;
export const SCAN_MIN_LENGTH = 4;
/** A burst with no Enter/Tab after this pause is taken as a scan from a scanner without a suffix. */
export const SCAN_NO_SUFFIX_FLUSH_MS = 150;
/** An Enter/Tab this soon after a scan is the second half of a CR+LF suffix. */
export const SCAN_SUFFIX_TAIL_MS = 150;

export interface ScanKeyEvent {
  key: string;
  code: string;
  time: number;
  repeat?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

export type ScanAction =
  /** Let the key through. `sequenceStart`: remember the focused field's value now. */
  | { type: 'pass'; sequenceStart?: boolean }
  /** Block the key. `burstStart`: undo what the burst already typed into the field. */
  | { type: 'swallow'; burstStart?: boolean }
  /** Block the key; `code` was scanned. */
  | { type: 'scan'; code: string; burstStart?: boolean };

const MODIFIER_KEYS = new Set(['Shift', 'CapsLock', 'NumLock', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS']);

/** The character a scanner meant, from the physical key (independent of the keyboard layout). */
export function scanCharOf(e: Pick<ScanKeyEvent, 'code' | 'shiftKey'>): string | null {
  let m = /^Digit([0-9])$/.exec(e.code);
  if (m) return e.shiftKey ? null : m[1];
  m = /^Numpad([0-9])$/.exec(e.code);
  if (m) return m[1];
  m = /^Key([A-Z])$/.exec(e.code);
  if (m) return e.shiftKey ? m[1] : m[1].toLowerCase();
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') return e.shiftKey ? null : '-';
  if (e.code === 'Period' || e.code === 'NumpadDecimal') return e.shiftKey ? null : '.';
  if (e.code === 'Slash' || e.code === 'NumpadDivide') return e.shiftKey ? null : '/';
  return null;
}

function isTerminator(e: ScanKeyEvent): boolean {
  return e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter' || e.key === 'Tab';
}

export class ScanDetector {
  private buffer = '';
  private lastTime = Number.NEGATIVE_INFINITY;
  private swallowing = false;
  private lastScanTime = Number.NEGATIVE_INFINITY;

  feed(e: ScanKeyEvent): ScanAction {
    if (e.ctrlKey || e.altKey || e.metaKey) {
      this.clear();
      return { type: 'pass' };
    }

    if (isTerminator(e)) {
      if (this.swallowing) {
        const code = this.buffer;
        this.clear();
        this.lastScanTime = e.time;
        return { type: 'scan', code };
      }
      this.clear();
      if (e.time - this.lastScanTime <= SCAN_SUFFIX_TAIL_MS) return { type: 'swallow' };
      return { type: 'pass' };
    }

    if (MODIFIER_KEYS.has(e.key) && !e.repeat) return { type: 'pass' };

    const ch = e.repeat ? null : scanCharOf(e);
    if (ch === null) {
      // Any other key ends a burst; inside a scan it is part of a code we cannot use.
      if (this.swallowing) return { type: 'swallow' };
      this.clear();
      return { type: 'pass' };
    }

    const gap = e.time - this.lastTime;
    this.lastTime = e.time;
    if (this.buffer === '' || gap > SCAN_MAX_GAP_MS) {
      this.buffer = ch;
      this.swallowing = false;
      return { type: 'pass', sequenceStart: true };
    }
    this.buffer += ch;
    if (this.swallowing) return { type: 'swallow' };
    if (this.buffer.length >= SCAN_MIN_LENGTH) {
      this.swallowing = true;
      return { type: 'swallow', burstStart: true };
    }
    return { type: 'pass' };
  }

  /** Call after a pause: returns a code scanned without a suffix, or null. */
  flush(now: number): string | null {
    if (!this.buffer || now - this.lastTime < SCAN_NO_SUFFIX_FLUSH_MS) return null;
    const code = this.swallowing ? this.buffer : null;
    this.clear();
    if (code) this.lastScanTime = now;
    return code;
  }

  /** True while a recognised scan is being read. */
  get scanning(): boolean {
    return this.swallowing;
  }

  private clear(): void {
    this.buffer = '';
    this.swallowing = false;
    this.lastTime = Number.NEGATIVE_INFINITY;
  }
}
