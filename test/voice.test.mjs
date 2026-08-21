// test/voice.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tagSituation, buildExemplarBank, exemplarsFor, learn, loadVoice, SITUATIONS } from '../src/voice.mjs';

test('tagSituation routes prompts to the right situation', () => {
  assert.equal(tagSituation('build the new parser'), 'kickoff');
  assert.equal(tagSituation('no that is wrong, revert it'), 'redirect-after-failure');
  assert.equal(tagSituation('prove it actually works, no slop'), 'demand-verification');
  assert.equal(tagSituation('commit and push it'), 'wrap-up');
  assert.equal(tagSituation('the test is failing, fix it'), 'unblock');
  assert.equal(tagSituation('keep going'), 'continue');
});

test('buildExemplarBank groups by tag and caps per tag', () => {
  const prompts = [
    { text: 'build a thing' }, { text: 'make another thing' }, { text: 'create a third' },
    { text: 'commit it' }, { text: 'prove it works' },
  ];
  const bank = buildExemplarBank(prompts, 2);
  assert.ok(bank.kickoff.length <= 2);
  assert.ok(Array.isArray(bank['wrap-up']));
  assert.deepEqual(Object.keys(bank).sort(), [...SITUATIONS].sort());
});

test('exemplarsFor falls back across tags when a situation is thin', () => {
  const bank = Object.fromEntries(SITUATIONS.map(s => [s, []]));
  bank['kickoff'] = ['a', 'b'];
  bank['continue'] = ['c', 'd', 'e'];
  const ex = exemplarsFor(bank, 'wrap-up', 3); // empty tag → fall back
  assert.equal(ex.length, 3);
});

test('learn reads a transcript dir, distills via injected engine, writes files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-voice-'));
  fs.copyFileSync(path.resolve('test/fixtures/transcript-sample.jsonl'), path.join(dir, 'a.jsonl'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-voiceout-'));

  let sawFence = false;
  const engine = async ({ prompt }) => { sawFence = /UNTRUSTED/.test(prompt); return { text: '## Summary\nterse and direct' }; };
  const res = await learn({ projectsDir: dir, engine, sampleN: 50, outDir: out });

  assert.ok(res.totalPrompts >= 3);
  assert.ok(sawFence, 'owner prompts were fenced as data in the distillation');
  assert.ok(fs.existsSync(res.profilePath));
  assert.ok(fs.existsSync(res.exemplarPath));

  const loaded = loadVoice(out);
  assert.match(loaded.profile, /terse and direct/);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test('loadVoice returns safe defaults when unlearned', () => {
  const v = loadVoice('/nonexistent/voice/dir');
  assert.match(v.profile, /direct|terse/);
  assert.deepEqual(Object.keys(v.bank).sort(), [...SITUATIONS].sort());
});
