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

test('a Codex session gets OpenAI creds, NOT Anthropic ones (round 5 M9)', () => {
  const src = { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'ant', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', OPENAI_API_KEY: 'oai' };
  const env = buildSessionEnv([], src, 'codex');
  assert.equal(env.OPENAI_API_KEY, 'oai');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);       // never leak Anthropic creds to Codex
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('a Claude session gets Anthropic creds, NOT OpenAI ones (round 5 M9)', () => {
  const src = { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'ant', OPENAI_API_KEY: 'oai' };
  const env = buildSessionEnv([], src, 'claude');
  assert.equal(env.ANTHROPIC_API_KEY, 'ant');
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test("engine 'none' admits ZERO provider credentials — for running untrusted acceptance tests (round 6 #1)", () => {
  const src = { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'ant', OPENAI_API_KEY: 'oai', CLAUDE_CODE_OAUTH_TOKEN: 'o' };
  const env = buildSessionEnv([], src, 'none');
  assert.equal(env.PATH, '/bin');                  // still runnable
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('allowedToolsFor includes the test runner and git, excludes push/gh', () => {
  const a = allowedToolsFor(['npm', 'test']);
  assert.match(a, /Bash\(npm test\)/);
  assert.match(a, /Bash\(git commit/);
  assert.doesNotMatch(a, /push/);
  assert.doesNotMatch(a, /\bgh\b/);
});

test('allowedToolsFor lets the agent INSTALL deps for the detected manager (clone omits node_modules) (round 28 #12b)', () => {
  assert.match(allowedToolsFor(['npm', 'test']), /Bash\(npm install\)/);
  assert.match(allowedToolsFor(['pnpm', 'test']), /Bash\(pnpm install\)/);   // RPLY's manager
  assert.match(allowedToolsFor(['bun', 'run', 'test']), /Bash\(bun install\)/);
  assert.match(allowedToolsFor(['pytest', '-q']), /Bash\(pip install -r \*\)/);   // requirements-scoped, not bare install *
  // still no publish/deploy/push escape hatch, and no bare `install *` wildcard (round 29)
  const p = allowedToolsFor(['pnpm', 'test']);
  assert.doesNotMatch(p, /publish|deploy|push/);
  assert.doesNotMatch(p, /install \*\)/);   // no `pnpm install *` wildcard
  // cargo/go don't get an npm-style install (they fetch during test)
  assert.doesNotMatch(allowedToolsFor(['cargo', 'test']), /install/);
});

test('allowedToolsFor grants the package manager install even when the acceptance is `node --test` (round 33 HIGH — #12b variant)', () => {
  // A JS repo with deps + a test/ dir but no scripts.test detects as ['node','--test']; node has no
  // INSTALL_CMDS entry, so the clone could NEVER bootstrap its (gitignored) deps and burned the full
  // budget every night on MODULE_NOT_FOUND. The package manager must be granted independent of argv[0].
  const tools = allowedToolsFor(['node', '--test'], 'pnpm');
  assert.match(tools, /Bash\(pnpm install\)/, 'the clone can bootstrap deps with its real package manager');
  assert.match(tools, /Bash\(node --test\)/, 'and still run the node --test acceptance');
  // without the pm, node --test alone grants NO install — the bug this closes
  assert.doesNotMatch(allowedToolsFor(['node', '--test']), /Bash\((npm|pnpm|yarn|bun) install\)/);
  // pm + a pm-test acceptance must not duplicate the install grant
  const dup = allowedToolsFor(['npm', 'test'], 'npm');
  assert.equal(dup.match(/Bash\(npm install\)/g).length, 1, 'no duplicate install grant');
});

test('buildSessionEnv: extraAllow can add app vars but NEVER another engine\'s provider key (round 29)', () => {
  const src = { PATH: '/b', ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai', DATABASE_URL: 'postgres://x' };
  // a Codex session that (mis)lists ANTHROPIC_API_KEY in extraAllow must still NOT receive it
  const env = buildSessionEnv(['DATABASE_URL', 'ANTHROPIC_API_KEY'], src, 'codex');
  assert.equal(env.DATABASE_URL, 'postgres://x');   // the app var is admitted
  assert.equal(env.OPENAI_API_KEY, 'sk-oai');        // its OWN engine's key is admitted
  assert.equal(env.ANTHROPIC_API_KEY, undefined);    // the OTHER engine's key is dropped despite extraAllow
});

test('ANTHROPIC_AUTH_TOKEN is a first-class Anthropic credential: kept for Claude, never leaked to Codex (round 31)', () => {
  const src = { PATH: '/b', ANTHROPIC_AUTH_TOKEN: 'sk-ant-auth', OPENAI_API_KEY: 'sk-oai' };
  // A Claude session authenticating via the auth-token method must actually RECEIVE it...
  assert.equal(buildSessionEnv([], src, 'claude').ANTHROPIC_AUTH_TOKEN, 'sk-ant-auth');
  // ...and a Codex session must NEVER get it, even when a card's extraAllow tries to smuggle it in
  // (it was missing from the round-29 cross-engine blocklist, so extraAllow could re-admit it).
  assert.equal(buildSessionEnv(['ANTHROPIC_AUTH_TOKEN'], src, 'codex').ANTHROPIC_AUTH_TOKEN, undefined);
});
