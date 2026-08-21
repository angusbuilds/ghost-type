#!/usr/bin/env node
// A stand-in binary that never exits — used to prove the engine's wall-clock timeout kills a
// runaway call and its whole process group (round 5 H4). It hangs ONLY when invoked like a real
// engine call (with `-p`); if `node --test` discovers and runs it bare, it exits immediately so
// it can never wedge the suite. The grandchild confirms the group (not just the top pid) is torn down.
import { spawn } from 'node:child_process';
if (process.argv.includes('-p')) {
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);   // a grandchild that would linger
  setInterval(() => {}, 1000);                                      // keep the parent alive forever
} else {
  process.exit(0);
}
