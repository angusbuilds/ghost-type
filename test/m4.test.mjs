// test/m4.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderReportHtml } from '../src/report-html.mjs';
import { verdictLine, notify, notifyVerdict } from '../src/notify.mjs';
import { recordLineage, readLineage, renderLineageMd } from '../src/lineage.mjs';

const night = {
  date: '2026-08-21', tokens: 12345, costUsd: 0.42,
  cards: [
    { project: 'demo', goal: 'pass parser test', outcome: 'shipped', mergeReady: true, whyLine: 'tests green', iterations: 2, branch: 'ghost/x', testOutput: 'ok 3', promptsWritten: ['fix the lexer'], falseDoneCount: 1 },
    { project: 'notes', goal: 'add flag', outcome: 'parked', mergeReady: false, whyLine: '3 strikes', iterations: 3, branch: 'ghost/y', testOutput: 'AssertionError', promptsWritten: [] },
  ],
};

test('renderReportHtml is self-contained, theme-aware, and shows real data', () => {
  const html = renderReportHtml(night);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /prefers-color-scheme: dark/);      // theme-aware
  assert.doesNotMatch(html, /https?:\/\//);              // no external assets
  assert.match(html, /ok 3/);                            // real test output
  assert.match(html, /false-done caught/);               // false-done surfaced
  assert.match(html, /ghost\/x/);
});

test('renderReportHtml escapes HTML in untrusted fields', () => {
  const evil = { ...night, cards: [{ ...night.cards[0], goal: '<script>alert(1)</script>' }] };
  const html = renderReportHtml(evil);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test('verdictLine summarizes shipped/parked/review', () => {
  assert.equal(verdictLine(night), '1 shipped · 1 parked · review 1 branch');
});

test('notify never throws and reports success via injected runner', () => {
  let called = null;
  assert.equal(notify('t', 'm', { runner: (title, msg) => { called = [title, msg]; } }), true);
  assert.deepEqual(called, ['t', 'm']);
  assert.equal(notify('t', 'm', { runner: () => { throw new Error('no osascript'); } }), false);
});

test('notifyVerdict pushes the one-line verdict', () => {
  let msg = '';
  notifyVerdict(night, { runner: (_t, m) => { msg = m; } });
  assert.match(msg, /1 shipped/);
});

test('lineage records and renders prompt history', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lin-')), 'lineage.jsonl');
  recordLineage(f, { iteration: 1, prompt: 'fix the lexer', outcome: 'fail' });
  recordLineage(f, { iteration: 2, prompt: 'isolate the tokenizer', outcome: 'shipped' });
  const entries = readLineage(f);
  assert.equal(entries.length, 2);
  const md = renderLineageMd(entries);
  assert.match(md, /fix the lexer/);
  assert.match(md, /shipped/);
});
