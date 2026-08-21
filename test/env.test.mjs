// test/env.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionEnv, allowedToolsFor } from '../src/env.mjs';

test('strips non-Claude API keys, keeps PATH/HOME, stamps GHOST_SESSION', () => {
  const src = { PATH: '/bin', HOME: '/h', FAL_KEY: 'x', ELEVENLABS_API_KEY: 'y', OPENAI_API_KEY: 'z', ANTHROPIC_API_KEY: 'keep-me' };
  const env = buildSessionEnv([], src);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/h');
  assert.equal(env.GHOST_SESSION, '1');
  assert.equal(env.FAL_KEY, undefined);
  assert.equal(env.ELEVENLABS_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('extraAllow re-admits a named var', () => {
  const env = buildSessionEnv(['FAL_KEY'], { PATH: '/bin', HOME: '/h', FAL_KEY: 'x' });
  assert.equal(env.FAL_KEY, 'x');
});

test('allowedToolsFor includes the test runner and git, excludes push/gh', () => {
  const a = allowedToolsFor(['npm', 'test']);
  assert.match(a, /Bash\(npm test\)/);
  assert.match(a, /Bash\(git commit/);
  assert.doesNotMatch(a, /push/);
  assert.doesNotMatch(a, /\bgh\b/);
});
