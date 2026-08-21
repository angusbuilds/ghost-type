// test/transcript.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractUserPrompts, cleanPromptText, parseTranscriptFile } from '../src/transcript.mjs';

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
