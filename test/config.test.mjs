// test/config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, DEFAULTS, nightDeadlineMs } from '../src/config.mjs';

function tmpCfg(obj) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cfg-')), 'config.json');
  if (obj !== undefined) fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

test('missing config falls back to defaults', () => {
  assert.deepEqual(loadConfig('/nope/config.json'), DEFAULTS);
});

test('stored values override, unknown keys ignored', () => {
  const cfg = loadConfig(tmpCfg({ maxTokensNight: 500000, nightDeadlineHour: 6, bogus: 'x' }));
  assert.equal(cfg.maxTokensNight, 500000);
  assert.equal(cfg.nightDeadlineHour, 6);
  assert.equal(cfg.bogus, undefined);
  assert.equal(cfg.maxCards, DEFAULTS.maxCards);   // untouched default kept
});

test('bad-typed / non-positive numeric values are rejected, keeping the default', () => {
  const cfg = loadConfig(tmpCfg({ maxTokensNight: -5, pollMs: 'fast', minStable: 4 }));
  assert.equal(cfg.maxTokensNight, DEFAULTS.maxTokensNight);
  assert.equal(cfg.pollMs, DEFAULTS.pollMs);
  assert.equal(cfg.minStable, 4);                  // valid override survives
});

test('nightDeadlineMs returns the next occurrence of the configured hour', () => {
  const now = Date.parse('2026-08-21T22:00:00');   // 10pm local
  const ms = nightDeadlineMs({ nightDeadlineHour: 7 }, now);
  const d = new Date(ms);
  assert.equal(d.getHours(), 7);
  assert.ok(ms > now);                              // tomorrow 7am
});
