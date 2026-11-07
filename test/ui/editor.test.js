import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber, fmt } from '../../src/ui/editor.js';

test('parseNumber accepts normal, exponent, inf and full-width input', () => {
  assert.equal(parseNumber('25.75'), 25.75);
  assert.equal(parseNumber(' -3 '), -3);
  assert.equal(parseNumber('1e-3'), 0.001);
  assert.equal(parseNumber('.5'), 0.5);
  assert.equal(parseNumber('inf', true), Infinity);
  assert.equal(parseNumber('Infinity', true), Infinity);
  assert.equal(parseNumber('∞', true), Infinity);
  assert.equal(parseNumber('-inf', true), -Infinity);
  assert.equal(parseNumber('５．５'), 5.5); // 全角 ５．５
  assert.equal(parseNumber('−２'), -2); // −２
});
test('parseNumber rejects garbage', () => {
  for (const s of ['', 'abc', '1.2.3', '5mm', 'inf']) assert.ok(Number.isNaN(parseNumber(s)), s);
});
test('fmt shows inf and trims float noise', () => {
  assert.equal(fmt(Infinity), 'inf');
  assert.equal(fmt(0.1 + 0.2), '0.3');
  assert.equal(fmt(NaN), '');
});
