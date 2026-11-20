/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Renders the real numeric input components (server-side markup, no browser): an empty value is
 * shown as an empty field with its placeholder, a real 0 is shown as 0, and the fields are plain
 * text inputs (no browser number spinner that fights Backspace). Typing behaviour is covered by
 * utils/numericInput.test.ts and the keyboard E2E test in e2e/numeric-inputs.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditableIntegerInput, EditableMoneyInput, EditableWeightInput } from './NumericInputs.tsx';

const noop = () => {};
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const valueOf = (markup: string) => /value="([^"]*)"/.exec(markup)?.[1];

test('integer input: empty value renders an empty field with the placeholder', () => {
  const m = html(React.createElement(EditableIntegerInput, { value: '', onChange: noop, placeholder: '1' }));
  assert.equal(valueOf(m), '');
  assert.match(m, /placeholder="1"/);
  assert.match(m, /type="text"/);
  assert.match(m, /inputMode="numeric"/);
  const u = html(React.createElement(EditableIntegerInput, { value: undefined, onChange: noop }));
  assert.equal(valueOf(u), '');
});

test('integer input: a real 0 is shown as 0, other values as typed', () => {
  assert.equal(valueOf(html(React.createElement(EditableIntegerInput, { value: 0, onChange: noop }))), '0');
  assert.equal(valueOf(html(React.createElement(EditableIntegerInput, { value: 42, onChange: noop }))), '42');
});

test('money input: empty stays empty, amounts are shown as given', () => {
  const m = html(React.createElement(EditableMoneyInput, { value: '', onChange: noop, placeholder: '0.00', required: true }));
  assert.equal(valueOf(m), '', 'required does not pre-fill 0.00');
  assert.match(m, /inputMode="decimal"/);
  assert.match(m, /required=""/);
  assert.equal(valueOf(html(React.createElement(EditableMoneyInput, { value: '12.50', onChange: noop }))), '12.50');
});

test('weight input: empty stays empty, kg text is shown as given', () => {
  const m = html(React.createElement(EditableWeightInput, { value: '', onChange: noop, ariaLabel: 'წონა' }));
  assert.equal(valueOf(m), '');
  assert.match(m, /placeholder="0.000"/);
  assert.match(m, /aria-label="წონა"/);
  assert.equal(valueOf(html(React.createElement(EditableWeightInput, { value: '0.375', onChange: noop }))), '0.375');
});

test('no numeric field uses type="number" (spinner, locale-dependent comma, sticky zero)', () => {
  for (const el of [
    React.createElement(EditableIntegerInput, { value: 1, onChange: noop }),
    React.createElement(EditableMoneyInput, { value: '1.00', onChange: noop }),
    React.createElement(EditableWeightInput, { value: '1.000', onChange: noop }),
  ]) {
    assert.doesNotMatch(html(el), /type="number"/);
  }
});
