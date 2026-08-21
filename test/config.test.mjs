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

test('per-field validation rejects values that would defeat safety limits (round 4 #8)', () => {
  const cfg = loadConfig(tmpCfg({
    nightDeadlineHour: 999,     // ~41 days out — must be rejected
    minStable: 1,               // too weak an idle signal — must be rejected
    maxCards: 2.5,              // fractional count — must be rejected
    defaultEngine: 'bogus',     // not a real engine — must be rejected
    pollMs: 10,                 // below the sane floor — must be rejected
  }));
  assert.equal(cfg.nightDeadlineHour, DEFAULTS.nightDeadlineHour);
  assert.equal(cfg.minStable, DEFAULTS.minStable);
  assert.equal(cfg.maxCards, DEFAULTS.maxCards);
  assert.equal(cfg.defaultEngine, DEFAULTS.defaultEngine);
  assert.equal(cfg.pollMs, DEFAULTS.pollMs);
});

test('midnight (hour 0) is a VALID deadline and a real engine name survives (round 4 #8)', () => {
  const cfg = loadConfig(tmpCfg({ nightDeadlineHour: 0, defaultEngine: 'codex' }));
  assert.equal(cfg.nightDeadlineHour, 0);   // 0 is valid, not falsy-rejected
  assert.equal(cfg.defaultEngine, 'codex');
});

test('sandbox is a boolean flag, default off (round 8)', () => {
  assert.equal(DEFAULTS.sandbox, false);
  assert.equal(loadConfig(tmpCfg({ sandbox: true })).sandbox, true);
  assert.equal(loadConfig(tmpCfg({ sandbox: 'yes' })).sandbox, false);   // non-boolean rejected
});

test('the shipped example config documents every real knob and loads cleanly', () => {
  const example = JSON.parse(fs.readFileSync(new URL('../examples/config.example.json', import.meta.url)));
  for (const k of Object.keys(DEFAULTS)) {
    assert.ok(k in example, `examples/config.example.json is missing the "${k}" knob`);
  }
  // and every example value must survive validation (i.e. the example itself is valid)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ex-'));
  const f = path.join(dir, 'config.json'); fs.writeFileSync(f, JSON.stringify(example));
  const cfg = loadConfig(f);
  for (const k of Object.keys(DEFAULTS)) assert.equal(cfg[k], example[k], `example value for "${k}" was rejected`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nightDeadlineMs returns the next occurrence of the configured hour', () => {
  const now = Date.parse('2026-08-21T22:00:00');   // 10pm local
  const ms = nightDeadlineMs({ nightDeadlineHour: 7 }, now);
  const d = new Date(ms);
  assert.equal(d.getHours(), 7);
  assert.ok(ms > now);                              // tomorrow 7am
});
