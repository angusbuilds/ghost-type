// src/transcript.mjs
// Extract the owner's genuinely-typed prompts from Claude Code transcript JSONL, filtering
// the heavy noise: slash-command wrappers, local-command echoes, tool results, meta rows,
// and injected system-reminder blocks. The format is internal/version-unstable, so this is
// deliberately tolerant — unknown shapes are skipped, never fatal.
import fs from 'node:fs';
import path from 'node:path';
import { scrubSecrets } from './sanitize.mjs';

const STRIP_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi,
  /<command-name>[\s\S]*?<\/command-name>/gi,
  /<command-message>[\s\S]*?<\/command-message>/gi,
  /<command-args>[\s\S]*?<\/command-args>/gi,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi,
];

// Return the real typed text, or null if this content is command/tool/meta noise.
export function cleanPromptText(s) {
  if (typeof s !== 'string') return null;
  let t = s;
  for (const re of STRIP_BLOCKS) t = t.replace(re, '');
  t = t.trim();
  if (!t) return null;
  if (t === '[Request interrupted by user]') return null;
  if (t.startsWith('<')) return null;   // leftover wrapper we don't recognize → noise
  if (t.length < 2) return null;
  return t;
}

// Parse one JSONL string into an array of {text, cwd, ts, session}.
export function extractUserPrompts(jsonlText) {
  const out = [];
  for (const line of String(jsonlText).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let j;
    try { j = JSON.parse(s); } catch { continue; }
    if (j.type !== 'user' || j.isMeta) continue;
    const m = j.message;
    if (!m || m.role !== 'user' || typeof m.content !== 'string') continue; // list content = tool result
    const clean = cleanPromptText(m.content);
    if (!clean) continue;
    out.push({ text: scrubSecrets(clean), cwd: j.cwd || '', ts: j.timestamp || '', session: j.sessionId || '' });
  }
  return out;
}

export function parseTranscriptFile(file) {
  return extractUserPrompts(fs.readFileSync(file, 'utf8'));
}

// Walk a projects dir (~/.claude/projects) and return all typed prompts, oldest→newest by
// timestamp when available. Missing dir → empty (never throws).
export function collectPrompts(projectsDir) {
  let files = [];
  try {
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith('.jsonl')) files.push(p);
      }
    };
    walk(projectsDir);
  } catch { return []; }
  const all = files.flatMap(f => { try { return parseTranscriptFile(f); } catch { return []; } });
  all.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return all;
}
