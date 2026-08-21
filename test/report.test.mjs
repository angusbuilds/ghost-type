// test/report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/report.mjs';

const night = {
  date: '2026-08-21', tokens: 12345, costUsd: 0.42,
  cards: [
    { project: 'demo', goal: 'pass the parser test', outcome: 'shipped', mergeReady: true, whyLine: 'tests green', iterations: 2, branch: 'ghost/2026-08-21-demo', testOutput: 'ok 3', promptsWritten: ['fix the lexer'] },
    { project: 'demo2', goal: 'add flag', outcome: 'parked', mergeReady: false, whyLine: '3 strikes on same failure', iterations: 3, branch: 'ghost/2026-08-21-flag', testOutput: 'AssertionError', promptsWritten: [] },
  ],
};

test('status strip lists every card before detail', () => {
  const md = renderReport(night);
  const stripIdx = md.indexOf('| demo ');
  const detailIdx = md.indexOf('## demo —');
  assert.ok(stripIdx > -1 && detailIdx > -1 && stripIdx < detailIdx);
});

test('renders merge-ready verdict and actual test output', () => {
  const md = renderReport(night);
  assert.match(md, /shipped/);
  assert.match(md, /ok 3/);
  assert.match(md, /3 strikes/);
});
