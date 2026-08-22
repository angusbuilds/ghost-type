// test/transcript.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractUserPrompts, cleanPromptText, parseTranscriptFile } from '../src/transcript.mjs';
import { GHOST_HOME } from '../src/lib.mjs';

test('extractUserPrompts excludes non-human rows: sidechain, Ghost-own clone sessions, writer/notification content (round 28 #9)', () => {
  const rows = [
    { type: 'user', message: { role: 'user', content: 'fix the failing parser test' }, cwd: '/Users/x/dev/app' },       // real human prompt — KEEP
    { type: 'user', message: { role: 'user', content: 'update the FEATURE.txt doc, it is stale' }, cwd: '/Users/x/dev/app' }, // a real prompt that MENTIONS feature.txt — KEEP (round 29: no over-filter)
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'audit this module for races' }, cwd: '/x' }, // a subagent prompt — DROP
    { type: 'user', message: { role: 'user', content: 'write FEATURE.txt now' }, cwd: `${GHOST_HOME}/work/ghost_a` },  // Ghost's own clone session (real work dir) — DROP
    { type: 'user', message: { role: 'user', content: 'WRITE EXACTLY IN THIS VOICE:\nterse' }, cwd: '/x' },            // Ghost's own writer prompt — DROP
    { type: 'user', message: { role: 'user', content: 'This session is being continued from a previous conversation. The summary...' }, cwd: '/x' }, // continuation summary — DROP
  ].map(r => JSON.stringify(r)).join('\n');
  const got = extractUserPrompts(rows).map(p => p.text);
  assert.deepEqual(got, ['fix the failing parser test', 'update the FEATURE.txt doc, it is stale']);   // both real prompts survive; Ghost-own dropped
});

const FIX = path.resolve('test/fixtures/transcript-sample.jsonl');

test('extracts only genuinely-typed prompts, dropping command/tool/meta noise', () => {
  const prompts = parseTranscriptFile(FIX);
  const texts = prompts.map(p => p.text);
  // real prompts: the build one, the redirect one, the keep-going one
  assert.equal(texts.length, 3);
  assert.ok(texts.some(t => /build the parser/.test(t)));
  assert.ok(texts.some(t => /revert that and prove/.test(t)));
  // noise excluded
  assert.ok(!texts.some(t => /local-command|command-name|tool_result|meta record|Request interrupted/.test(t)));
});

test('strips injected system-reminder blocks from real prompts', () => {
  const prompts = parseTranscriptFile(FIX);
  const redirect = prompts.find(p => /revert/.test(p.text));
  assert.doesNotMatch(redirect.text, /injected context|system-reminder/);
});

test('scrubs secrets out of extracted prompts', () => {
  const prompts = parseTranscriptFile(FIX);
  const withKey = prompts.find(p => /keep going/.test(p.text));
  assert.doesNotMatch(withKey.text, /sk-abc123/);
  assert.match(withKey.text, /redacted/);
});

test('cleanPromptText returns null for pure command noise, text for real input', () => {
  assert.equal(cleanPromptText('<command-name>/x</command-name>'), null);
  assert.equal(cleanPromptText('[Request interrupted by user]'), null);
  assert.equal(cleanPromptText('  '), null);
  assert.equal(cleanPromptText('make the gallery lazy-load'), 'make the gallery lazy-load');
});

test('tolerates malformed JSON lines without throwing', () => {
  assert.doesNotThrow(() => extractUserPrompts('not json\n{"type":"user"}\n'));
});
