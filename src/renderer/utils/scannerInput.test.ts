/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * USB barcode scanner (HID keyboard wedge) detection: the same ScanDetector the sales screen
 * uses, fed with key timings of a scanner and of a person.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ScanDetector, ScanAction, ScanKeyEvent, scanCharOf, SCAN_NO_SUFFIX_FLUSH_MS } from './scannerInput.ts';

const digitKey = (d: string, time: number, extra: Partial<ScanKeyEvent> = {}): ScanKeyEvent => ({ key: d, code: `Digit${d}`, time, ...extra });
const enter = (time: number): ScanKeyEvent => ({ key: 'Enter', code: 'Enter', time });

/** Types `text` like a scanner (or a person) and returns every action, plus the scanned codes. */
function type(det: ScanDetector, text: string, start: number, gapMs: number, suffix: 'Enter' | 'Tab' | 'CRLF' | 'none' = 'Enter') {
  const actions: ScanAction[] = [];
  let t = start;
  for (const ch of text) {
    actions.push(det.feed(digitKey(ch, t)));
    t += gapMs;
  }
  if (suffix === 'Enter' || suffix === 'CRLF') actions.push(det.feed(enter(t)));
  if (suffix === 'CRLF') actions.push(det.feed(enter(t + 3)));
  if (suffix === 'Tab') actions.push(det.feed({ key: 'Tab', code: 'Tab', time: t }));
  const codes = actions.filter((a) => a.type === 'scan').map((a) => (a as any).code);
  return { actions, codes, end: t };
}

test('scanner: EAN-13 at 8 ms per key with Enter is one scan, leading zeros kept', () => {
  const det = new ScanDetector();
  const r = type(det, '0004006381333', 1000, 8);
  assert.deepEqual(r.codes, ['0004006381333']);
  // the first 3 keys pass (could be a person), the 4th starts the burst and undoes them
  assert.deepEqual(r.actions.slice(0, 4).map((a) => a.type), ['pass', 'pass', 'pass', 'swallow']);
  assert.equal((r.actions[0] as any).sequenceStart, true);
  assert.equal((r.actions[3] as any).burstStart, true);
  assert.ok(r.actions.slice(4).every((a) => a.type !== 'pass'), 'no later key reaches the page');
});

test('scanner: a 5-digit store code, EAN-8, UPC-A and ITF-14 are recognised', () => {
  for (const code of ['10001', '96385074', '036000291452', '10012345678902']) {
    const det = new ScanDetector();
    assert.deepEqual(type(det, code, 0, 12).codes, [code], code);
  }
});

test('person: typing a code at human speed is never a scan', () => {
  const det = new ScanDetector();
  const r = type(det, '4860001234567', 0, 120);
  assert.deepEqual(r.codes, []);
  assert.ok(r.actions.every((a) => a.type === 'pass'), 'every key and the Enter go to the page');
});

test('person: two keys pressed almost together (roll-over) are not a scan', () => {
  const det = new ScanDetector();
  const a = det.feed(digitKey('1', 0));
  const b = det.feed(digitKey('2', 15));
  const c = det.feed(digitKey('3', 200));
  const d = det.feed(enter(400));
  assert.deepEqual([a.type, b.type, c.type, d.type], ['pass', 'pass', 'pass', 'pass']);
});

test('held-down key (auto-repeat ~33 ms) is not a scan', () => {
  const det = new ScanDetector();
  const acts = [det.feed(digitKey('7', 0))];
  for (let i = 1; i < 10; i++) acts.push(det.feed(digitKey('7', i * 33, { repeat: true })));
  acts.push(det.feed(enter(400)));
  assert.ok(acts.every((a) => a.type === 'pass'));
});

test('rapid scanning: ten scans in a row give ten codes in order', () => {
  const det = new ScanDetector();
  const expected: string[] = [];
  const got: string[] = [];
  let t = 0;
  for (let i = 0; i < 10; i++) {
    const code = `48600012345${String(i).padStart(2, '0')}`;
    expected.push(code);
    const r = type(det, code, t, 5);
    got.push(...r.codes);
    t = r.end + 60; // the next item is in front of the scanner 60 ms later
  }
  assert.deepEqual(got, expected);
});

test('Tab suffix works; CR+LF suffix does not leak a second Enter', () => {
  assert.deepEqual(type(new ScanDetector(), '12345678', 0, 6, 'Tab').codes, ['12345678']);
  const det = new ScanDetector();
  const r = type(det, '12345678', 0, 6, 'CRLF');
  assert.deepEqual(r.codes, ['12345678']);
  assert.equal(r.actions[r.actions.length - 1].type, 'swallow', 'the LF Enter is swallowed');
  // a later Enter by the seller passes again
  assert.equal(det.feed(enter(r.end + 1000)).type, 'pass');
});

test('scanner without a suffix: the code is delivered after a pause', () => {
  const det = new ScanDetector();
  const r = type(det, '2000000000015', 0, 7, 'none');
  assert.deepEqual(r.codes, []);
  assert.equal(det.flush(r.end + 10), null, 'too early');
  assert.equal(det.flush(r.end + SCAN_NO_SUFFIX_FLUSH_MS + 1), '2000000000015');
  assert.equal(det.flush(r.end + 1000), null, 'delivered once');
});

test('a person typing two digits and pausing loses nothing to the flush', () => {
  const det = new ScanDetector();
  det.feed(digitKey('1', 0));
  det.feed(digitKey('2', 150));
  assert.equal(det.flush(1000), null);
  assert.equal(det.feed(enter(1100)).type, 'pass');
});

test('keyboard layout and NumLock do not change the code (read from the physical key)', () => {
  // Georgian layout: the Digit keys still report Digit codes; letters arrive as Georgian
  // characters in e.key but KeyA.. in e.code.
  assert.equal(scanCharOf({ code: 'Digit0' }), '0');
  assert.equal(scanCharOf({ code: 'KeyA' }), 'a');
  assert.equal(scanCharOf({ code: 'KeyA', shiftKey: true }), 'A');
  // NumLock off: the key is "End" but the code is Numpad1
  const det = new ScanDetector();
  const keys = ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5'];
  const acts = keys.map((code, i) => det.feed({ key: 'End', code, time: i * 6 }));
  const done = det.feed({ key: 'Enter', code: 'NumpadEnter', time: 40 });
  assert.equal(acts[3].type, 'swallow');
  assert.deepEqual(done, { type: 'scan', code: '12345' });
  assert.equal(scanCharOf({ code: 'Digit1', shiftKey: true }), null, 'Shift+1 is "!" on a person\'s keyboard');
});

test('shortcuts (Ctrl/Alt) are never part of a scan', () => {
  const det = new ScanDetector();
  det.feed(digitKey('1', 0));
  det.feed(digitKey('2', 5));
  det.feed({ key: 'v', code: 'KeyV', ctrlKey: true, time: 10 });
  det.feed(digitKey('3', 15));
  assert.equal(det.feed(enter(20)).type, 'pass');
});
