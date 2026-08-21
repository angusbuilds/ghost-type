// test/voice-upgrade.test.mjs — the study-driven voice upgrades.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadVoice, DEFAULT_VOICE_PROFILE, seedBank } from '../src/voice.mjs';
import { cleanPromptText } from '../src/transcript.mjs';

test('default voice profile encodes the real fingerprint, not the old one-liner', () => {
  assert.match(DEFAULT_VOICE_PROFILE, /lowercase/);
  assert.match(DEFAULT_VOICE_PROFILE, /NEVER use "!"/);
  assert.match(DEFAULT_VOICE_PROFILE, /do NOT fix typos/i);
  assert.doesNotMatch(DEFAULT_VOICE_PROFILE, /^direct, terse, verification-driven$/);
});

test('unlearned loadVoice returns the fingerprint profile + seeded exemplars', () => {
  const v = loadVoice('/nonexistent/voice');
  assert.equal(v.profile, DEFAULT_VOICE_PROFILE);
  const all = Object.values(v.bank).flat();
  assert.ok(all.some(q => /gooo/i.test(q)), 'seed exemplars include his real go-signal');
  assert.ok(all.some(q => /shit/i.test(q)), 'seed exemplars include a real redirect');
});

test('seedBank tags the redirect quote as redirect-after-failure', () => {
  const bank = seedBank();
  assert.ok(bank['redirect-after-failure'].some(q => /shit/i.test(q)));
});

test('transcript filters synthetic eval probes out of the voice corpus', () => {
  assert.equal(cleanPromptText('Reply with exactly: CLAUDE_OK'), null);
  assert.equal(cleanPromptText('How many rs are in strawberry?'), null);
  assert.equal(cleanPromptText('Name a country whose flag has no red'), null);
  assert.equal(cleanPromptText('make it fucking clean'), 'make it fucking clean');
});
