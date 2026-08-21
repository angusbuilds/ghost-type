#!/usr/bin/env node
// Watch a terminal turn purple, the way a haunted pane will look.
// Usage: node bin/ghost-tint-demo.mjs
import { tintStream, resetStream, inTmux, GHOST_PURPLE } from '../src/tint.mjs';

const hold = Number(process.argv[2] || 3);
process.stdout.write(`\n👻 Ghost Type is taking this terminal for ${hold}s…\n`);
tintStream(process.stdout, GHOST_PURPLE);

// Restore the background on exit no matter how we leave.
const restore = () => { resetStream(process.stdout); process.stdout.write('\n✅ released.\n'); };
process.on('SIGINT', () => { restore(); process.exit(0); });

setTimeout(() => {
  restore();
  if (inTmux()) process.stdout.write('(tip: inside tmux, per-pane tinting glows just this pane)\n');
  process.exit(0);
}, hold * 1000);
