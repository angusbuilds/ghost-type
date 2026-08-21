// src/voice.mjs
// Turn the owner's real typed prompts into a reusable voice: a situation-tagged exemplar
// bank plus a distilled voice-profile.md. Sampled + single-pass by design (M2 scope) — the
// full-corpus clustering pipeline is later.
import fs from 'node:fs';
import path from 'node:path';
import { GHOST_HOME } from './lib.mjs';
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

// Group prompts by situation, keeping the most recent `perTag` of each (input assumed
// oldest→newest). Returns { tag: [text, ...] }.
export function buildExemplarBank(prompts, perTag = 5) {
  const bank = Object.fromEntries(SITUATIONS.map(s => [s, []]));
  for (const p of prompts) {
    const tag = tagSituation(p.text);
    bank[tag].push(p.text);
  }
  for (const s of SITUATIONS) bank[s] = bank[s].slice(-perTag);
  return bank;
}

export function sampleRecent(prompts, n = 200) {
  return prompts.slice(-n);
}

// Distill a voice-profile.md via the injected engine. The owner's own prompts are still
// fenced as data (never instructions) so a past prompt can't hijack the distillation.
export async function distillVoiceProfile({ prompts, engine }) {
  const sample = prompts.map(p => `- ${p.text}`).join('\n');
  const r = await engine({
    prompt: [
      "You are building a VOICE PROFILE of a developer from a sample of prompts they actually typed to coding agents. Capture how THEY write instructions so another system can draft prompts that sound like them.",
      fence('their-prompts', sample),
      'Write a markdown profile with exactly these 9 sections:',
      '## Summary\n## Directness & Tone\n## Sentence structure & length\n## Vocabulary / characteristic phrasings\n## Punctuation & formatting habits\n## Verification & "prove it" habits\n## Redirect-after-failure style\n## Judgment & priorities\n## What to Avoid',
      'Be concrete and quote real phrasings they use. Output only the markdown.',
    ].join('\n\n'),
  });
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
  fs.writeFileSync(profilePath, profile + '\n');
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
  try { profile = fs.readFileSync(path.join(outDir, 'voice-profile.md'), 'utf8'); } catch { /* unlearned */ }
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(outDir, 'exemplars.json'), 'utf8'));
    // Stored on top, seed as the floor so thin situations still have his voice.
    for (const s of SITUATIONS) bank[s] = [...(bank[s] || []), ...(stored[s] || [])].slice(-8);
  } catch { /* unlearned — keep seed */ }
  return { profile, bank };
}

// Pick exemplars for a situation, falling back across tags so the writer always gets some.
export function exemplarsFor(bank, situation, n = 4) {
  const primary = bank[situation] || [];
  if (primary.length >= n) return primary.slice(-n);
  const rest = SITUATIONS.filter(s => s !== situation).flatMap(s => bank[s] || []);
  return [...primary, ...rest].slice(-n);
}
