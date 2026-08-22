// src/voice.mjs
// Turn the owner's real typed prompts into a reusable voice: a situation-tagged exemplar
// bank plus a distilled voice-profile.md. Sampled + single-pass by design (M2 scope) — the
// full-corpus clustering pipeline is later.
import fs from 'node:fs';
import path from 'node:path';
import { GHOST_HOME, byteCap, engineFailed } from './lib.mjs';
import { fence } from './sanitize.mjs';
import { collectPrompts } from './transcript.mjs';

export const VOICE_DIR = path.join(GHOST_HOME, 'voice');
export const SITUATIONS = ['kickoff', 'continue', 'redirect-after-failure', 'demand-verification', 'unblock', 'wrap-up'];

// Evidence-based default (from a 458-prompt study of his real history). Used until
// `ghost learn` distills a richer one. This is what the prompt-writer imitates.
export const DEFAULT_VOICE_PROFILE = [
  'Write like Angus: all-lowercase, terse, directive.',
  'NEVER use "!" — use CAPS or letter-stretching ("gooo") for emphasis instead.',
  'Rarely ask questions — tell, don\'t ask. Most lines end with no terminal punctuation.',
  'Drop apostrophes under speed ("lets", "dont", "im"). Do NOT fix typos or polish — rough is the signal.',
  'Profanity is an intensifier ("make it fucking clean", "lock the fuck in"), never an attack.',
  'Redirect after a failure with one blunt verdict fused straight into the next instruction ("right now its kinda shit, open it up and fix it fully") — no diagnosis paragraph.',
  'He wants to SEE it work ("show me", "let me see"), not be told it\'s proven.',
  'Keep it short — often under 12 words.',
].join('\n');

// Real prompts of his, as a floor of exemplars until learning runs.
const SEED_QUOTES = [
  'gooo', 'lets see it', 'right now its kinda shit open it up', 'make it actually super fucking clean',
  'lets fucking lock the fuck in', 'come up with a cool domain that isnt taken', 'build everthign get it fully finish',
  'no wait this is shit we have to work on givining you real inspo', 'make sure you dont crash my comuter tho',
  'STOP GOOOOOO', 'Right now it\'s shit. Fix it fully', 'show me the interface', 'keep going', '100 times better',
];

// Keyword heuristic — specific situations checked before broad ones.
const RULES = [
  ['demand-verification', /\b(verify|prove|make sure|test it|does it (actually|really)|show me|no slop|actually work)/i],
  ['redirect-after-failure', /\b(no,|actually|instead|wait|stop|that'?s wrong|revert|undo|not (what|like) that)/i],
  ['unblock', /\b(blocked|stuck|error|failing|broken|fix|why (is|isn'?t|does|are))/i],
  ['wrap-up', /\b(commit|push|ship it|finish|wrap up|clean up|finalize|give me the link|save (everything|it)|deploy)/i],
  ['kickoff', /\b(build|make|create|let'?s|start|new project|add|implement|set up)/i],
  ['continue', /\b(keep going|continue|next|carry on|go on|more|gooo|go)/i],
];

export function tagSituation(text) {
  for (const [tag, re] of RULES) if (re.test(text)) return tag;
  return 'continue';
}

// A stored exemplar is a short imitation target — voice lives in the brief ones, and his
// real history has 650KB pasted monsters. Cap every stored exemplar so the bank (and every
// writer prompt that later concatenates it) stays bounded (round 4 #6).
export const EXEMPLAR_CAP = 280;
// The distilled voice profile is 9 short sections — cap it so a runaway distillation can't
// bloat the file that rides into every prompt (round 5 review #7).
export const PROFILE_CAP = 6000;

// Group prompts by situation, keeping the most recent `perTag` of each (input assumed
// oldest→newest). Returns { tag: [text, ...] }.
export function buildExemplarBank(prompts, perTag = 5) {
  const bank = Object.fromEntries(SITUATIONS.map(s => [s, []]));
  for (const p of prompts) {
    const tag = tagSituation(p.text);
    bank[tag].push(byteCap(String(p.text).replace(/\n+/g, ' ').trim(), EXEMPLAR_CAP));
  }
  for (const s of SITUATIONS) bank[s] = bank[s].slice(-perTag);
  return bank;
}

export function sampleRecent(prompts, n = 200) {
  return prompts.slice(-n);
}

// Distill a voice-profile.md via the injected engine. The owner's own prompts are still
// fenced as data (never instructions) so a past prompt can't hijack the distillation.
export async function distillVoiceProfile({ prompts, engine, maxEach = 500, maxTotalBytes = 40_000 }) {
  // Cap each prompt AND the whole sample — his real history has monster pasted prompts
  // (the longest is 650KB), and voice lives in the short ones anyway. Keeps the distill
  // call bounded and cheap, and can't blow the context window.
  const sample = byteCap(prompts.map(p => `- ${byteCap(String(p.text).replace(/\n+/g, ' '), maxEach)}`).join('\n'), maxTotalBytes);
  const r = await engine({
    prompt: [
      "You are building a VOICE PROFILE of a developer from a sample of prompts they actually typed to coding agents. Capture how THEY write instructions so another system can draft prompts that sound like them.",
      fence('their-prompts', sample),
      'Write a markdown profile with exactly these 9 sections:',
      '## Summary\n## Directness & Tone\n## Sentence structure & length\n## Vocabulary / characteristic phrasings\n## Punctuation & formatting habits\n## Verification & "prove it" habits\n## Redirect-after-failure style\n## Judgment & priorities\n## What to Avoid',
      'Be concrete and quote real phrasings they use. Output only the markdown.',
    ].join('\n\n'),
  });
  // A FAILED engine call returns its ERROR text (a transport error, or a rate/usage limit as
  // is_error:true) — signal empty so `learn` won't persist that over a good profile (round 28 #11 + #3-variant).
  if (engineFailed(r)) return '';
  return (r.text || '').trim();
}

// Full learn pass: read transcripts, sample, build exemplars, distill, write to disk.
// Returns a summary. Injected engine keeps it testable offline.
export async function learn({ projectsDir, engine, sampleN = 200, perTag = 5, outDir = VOICE_DIR }) {
  const all = collectPrompts(projectsDir);
  const sample = sampleRecent(all, sampleN);
  const bank = buildExemplarBank(all, perTag);
  const profile = await distillVoiceProfile({ prompts: sample, engine });

  fs.mkdirSync(outDir, { recursive: true });
  const profilePath = path.join(outDir, 'voice-profile.md');
  const exemplarPath = path.join(outDir, 'exemplars.json');
  // A failed/empty distillation must NOT overwrite a good existing profile (or exemplars) with an
  // error string — a failed `ghost learn` is a no-op that keeps the last good voice (round 28 #11).
  if (!profile) return { totalPrompts: all.length, sampled: sample.length, profilePath, exemplarPath, bank, skipped: 'distillation failed — kept existing voice' };
  // Cap the distilled profile before it's persisted — a runaway model response would otherwise
  // be stored uncapped and re-injected into every future prompt (round 5 review #7).
  fs.writeFileSync(profilePath, byteCap(profile, PROFILE_CAP) + '\n');
  fs.writeFileSync(exemplarPath, JSON.stringify(bank, null, 2));

  return { totalPrompts: all.length, sampled: sample.length, profilePath, exemplarPath, bank };
}

// The seed exemplar bank: the real quotes, tagged into situations by the classifier.
export function seedBank() {
  return buildExemplarBank(SEED_QUOTES.map(text => ({ text })), 6);
}

// Load the stored voice for the Prompt Writer. Falls back to the evidence-based default
// profile + seed exemplars (never the old content-free one-liner) when unlearned.
export function loadVoice(outDir = VOICE_DIR) {
  let profile = DEFAULT_VOICE_PROFILE;
  let bank = seedBank();
  // Cap on read too, in case the file predates PROFILE_CAP (round 5 review #7).
  try { profile = byteCap(fs.readFileSync(path.join(outDir, 'voice-profile.md'), 'utf8'), PROFILE_CAP); } catch { /* unlearned */ }
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(outDir, 'exemplars.json'), 'utf8'));
    // Stored on top, seed as the floor so thin situations still have his voice. Cap each
    // stored exemplar in case the file predates EXEMPLAR_CAP (round 4 #6).
    for (const s of SITUATIONS) bank[s] = [...(bank[s] || []), ...(stored[s] || []).map(t => byteCap(String(t), EXEMPLAR_CAP))].slice(-8);
  } catch { /* unlearned — keep seed */ }
  return { profile, bank };
}

// Pick exemplars for a situation, falling back across tags so the writer always gets some.
export function exemplarsFor(bank, situation, n = 4) {
  const primary = (bank[situation] || []).slice(-n);   // the freshest situation-specific examples, kept FIRST
  if (primary.length >= n) return primary;
  const rest = SITUATIONS.filter(s => s !== situation).flatMap(s => bank[s] || []);
  // Fill only the REMAINING slots with fallback — the old `[...primary, ...rest].slice(-n)` dropped the
  // situation-specific example off the front whenever fallback existed (round 28 #10).
  return [...primary, ...rest.slice(-(n - primary.length))];
}
