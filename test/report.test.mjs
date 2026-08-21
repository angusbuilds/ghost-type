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

test('untrusted fields cannot break the table or the code fence (round 4 #10)', () => {
  const dirty = {
    date: '2026-08-21', tokens: 1, costUsd: 0,
    cards: [{
      project: 'p | evil', goal: 'g\nnewline', outcome: 'parked', mergeReady: false,
      whyLine: 'why | with | pipes\nand newline', iterations: 0,
      branch: 'ghost/x', testOutput: 'before ``` after fence', promptsWritten: ['a | b'],
    }],
  };
  const md = renderReport(dirty);
  // every table row still has exactly the 3-column shape — count only DELIMITER pipes, not
  // the escaped `\|` literals the sanitizer produced inside a cell.
  for (const row of md.split('\n').filter(l => l.startsWith('| ') && !l.includes('---') && !l.includes('merge-ready'))) {
    const structural = row.replace(/\\\|/g, '');   // drop escaped (literal) pipes
    assert.equal(structural.split('|').length, 5, `row kept 3 cells: ${row}`);   // leading + 3 cells + trailing = 5 splits
  }
  assert.doesNotMatch(md, /before ```\n?```/);   // the embedded ``` was neutralized, fence intact
});

test('a skipped (proposal-only) card is counted and rendered, not dropped (round 4 #7)', () => {
  const md = renderReport({
    date: '2026-08-21', tokens: 0, costUsd: 0,
    cards: [{ project: 'noRunner', goal: 'x', outcome: 'skipped', mergeReady: false, whyLine: 'proposal-only — no test runner', iterations: 0, branch: 'ghost/np', testOutput: '', promptsWritten: [] }],
  });
  assert.match(md, /1 skipped/);
  assert.match(md, /proposal-only/);
});
