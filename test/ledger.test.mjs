// test/ledger.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.mjs';

test('records attempts and renders a table with every row', () => {
  const l = new Ledger();
  l.record({ iteration: 1, prompt: 'fix the lexer', outcome: 'fail', exitCode: 1, stderrHead: 'AssertionError', howClose: 'tests still red' });
  l.record({ iteration: 2, prompt: 'revert and isolate tokenizer', outcome: 'fail', exitCode: 1, stderrHead: 'TypeError', howClose: 'different error now' });
  assert.equal(l.rows.length, 2);
  const t = l.toTable();
  assert.match(t, /fix the lexer/);
  assert.match(t, /revert and isolate tokenizer/);
  assert.match(t, /AssertionError/);
});

test('empty ledger renders a placeholder, not a broken table', () => {
  assert.match(new Ledger().toTable(), /no attempts yet/i);
});

test('long prompts are truncated in the table', () => {
  const l = new Ledger();
  l.record({ iteration: 1, prompt: 'x'.repeat(500), outcome: 'fail', exitCode: 1, stderrHead: '', howClose: '' });
  assert.ok(l.toTable().length < 500 + 200);
});

test('a pipe in captured stderr is escaped so it cannot break the table (round 5 #2)', () => {
  const l = new Ledger();
  l.record({ iteration: 1, prompt: 'run', outcome: 'fail', exitCode: 1, stderrHead: 'grep foo | wc -l → 3', howClose: 'a | b' });
  const row = l.toTable().split('\n').at(-1);
  assert.equal(row.replace(/\\\|/g, '').split('|').length, 7);   // leading + 5 cells + trailing
  assert.match(l.toTable(), /grep foo \\\| wc/);                 // the pipe was escaped
});
