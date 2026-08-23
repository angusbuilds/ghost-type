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

test('renderReportHtml labels a skipped card as skipped, not parked (round 5 M8)', () => {
  const withSkip = { ...night, cards: [{ project: 'noRunner', goal: 'x', outcome: 'skipped', mergeReady: false, whyLine: 'proposal-only', iterations: 0, branch: 'ghost/z', testOutput: '', promptsWritten: [] }] };
  const html = renderReportHtml(withSkip);
  assert.match(html, /⊘ skipped/);
  assert.match(html, /1 skipped/);      // counted in the verdict strip
});

test('renderReportHtml counts a PROPOSED card in the verdict strip, matching the markdown report (round 34)', () => {
  // A no-runner repo produces outcome:'proposed'. The HTML verdict strip counted only shipped/parked/
  // skipped, so a proposed card silently vanished from the headline the owner reads first — and the
  // side-by-side markdown report (which DOES count proposed) disagreed on total cards processed.
  const withProposed = { ...night, cards: [
    { project: 'demo', goal: 'x', outcome: 'shipped', mergeReady: true, whyLine: 'green', iterations: 1, branch: 'ghost/a', testOutput: 'ok', promptsWritten: [] },
    { project: 'noRunner', goal: 'y', outcome: 'proposed', mergeReady: false, whyLine: 'plan written', iterations: 0, branch: 'ghost/b', testOutput: '', promptsWritten: [] },
  ] };
  const html = renderReportHtml(withProposed);
  assert.match(html, /1 proposed/);   // present in the headline, not silently dropped
});

test('verdictLine surfaces proposals so a proposal-only night is not pushed as "0 shipped · 0 parked" (round 34)', () => {
  const proposalNight = { ...night, cards: [
    { project: 'noRunner', goal: 'x', outcome: 'proposed', mergeReady: false, whyLine: 'plan written', iterations: 0, branch: 'ghost/p', testOutput: '', promptsWritten: [] },
  ] };
  assert.equal(verdictLine(proposalNight), '0 shipped · 1 proposed · 0 parked · review 0 branches');
});

test('verdictLine summarizes shipped/parked/review', () => {
  assert.equal(verdictLine(night), '1 shipped · 1 parked · review 1 branch');   // no proposals → terse, unchanged
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

test('a truncated trailing line does not discard the whole lineage (round 5 #3)', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lin-')), 'lineage.jsonl');
  recordLineage(f, { iteration: 1, prompt: 'good row', outcome: 'fail' });
  fs.appendFileSync(f, '{"iteration":2,"prompt":"trunc');   // crash mid-append — no newline, invalid JSON
  const entries = readLineage(f);
  assert.equal(entries.length, 1);              // the valid row survives...
  assert.equal(entries[0].prompt, 'good row');  // ...instead of the whole file being dropped
});

test('recordLineage byteCaps the prompt and bounds the file so a runaway prompt / long-lived project cannot grow it without limit (round 35)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lineage-'));
  const file = path.join(dir, 'lineage-p.jsonl');
  recordLineage(file, { iteration: 1, prompt: 'x'.repeat(1_000_000), outcome: 'no-patch' });   // runaway prompt
  const firstLine = fs.readFileSync(file, 'utf8').split('\n')[0];
  assert.ok(Buffer.byteLength(firstLine) < 5000, `entry bounded: ${Buffer.byteLength(firstLine)} bytes`);
  for (let i = 0; i < 6000; i++) recordLineage(file, { iteration: i, prompt: 'a moderately sized next prompt '.repeat(20), outcome: 'fail' });
  assert.ok(fs.statSync(file).size < 2_000_000, `file bounded by rotation: ${fs.statSync(file).size} bytes`);
  const rows = readLineage(file);   // still valid JSONL after rotation
  assert.ok(rows.length > 0 && rows.every(r => typeof r.iteration === 'number'));
  fs.rmSync(dir, { recursive: true, force: true });
});
