// test/dossier.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectTestRunner, scanRepo } from '../src/dossier.mjs';

function tmp(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dos-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(d, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(d, name), content);
  }
  return d;
}

test('detects npm test from package.json', () => {
  const d = tmp({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
  assert.deepEqual(detectTestRunner(d), ['npm', 'test']);
});

test('detects cargo / go / pytest by manifest', () => {
  assert.deepEqual(detectTestRunner(tmp({ 'Cargo.toml': '' })), ['cargo', 'test']);
  assert.deepEqual(detectTestRunner(tmp({ 'go.mod': 'module x' })), ['go', 'test', './...']);
  assert.deepEqual(detectTestRunner(tmp({ 'pyproject.toml': '' })), ['pytest', '-q']);
});

test('returns null when no runner is detectable', () => {
  assert.equal(detectTestRunner(tmp({ 'README.md': 'hi' })), null);
});

test('ignores the npm placeholder test script', () => {
  const d = tmp({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
  assert.equal(detectTestRunner(d), null);
});

test('scanRepo reports runner + canRunUnattended', () => {
  const d = tmp({ 'Cargo.toml': '', 'RESUME.md': 'x' });
  const dossier = scanRepo(d, { gitRunner: () => '' });
  assert.deepEqual(dossier.testRunner, ['cargo', 'test']);
  assert.equal(dossier.canRunUnattended, true);
  assert.equal(dossier.hasResume, true);
});
