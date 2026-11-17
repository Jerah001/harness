#!/usr/bin/env node
// SessionStart: when a person opens an interactive session here, show it where the project
// stands. Sessions started by the harness already get a full brief in their prompt.
import fs from 'node:fs';
import path from 'node:path';

if (process.env.HARNESS_PROBE) {
  // `harness doctor --live` reads back what the hooks saw.
  try {
    const { hook_event_name: event, agent_type, permission_mode, source } = JSON.parse(fs.readFileSync(0, 'utf8'));
    fs.appendFileSync(process.env.HARNESS_PROBE, `${JSON.stringify({ hook: 'session-context', event, agent_type, permission_mode, source })}\n`);
  } catch {
    /* best effort */
  }
}
if (process.env.HARNESS_ROLE) process.exit(0);
const dir = process.env.HARNESS_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd();

const read = (name) => {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8');
  } catch {
    return '';
  }
};
const section = (text, from, to) => {
  const a = text.indexOf(from);
  if (a === -1) return '';
  const b = to ? text.indexOf(to, a + from.length) : -1;
  return text.slice(a, b === -1 ? undefined : b).trim();
};

const state = read('STATE.md');
const handoff = read('HANDOFF.md');
if (!state && !handoff) process.exit(0);

const parts = [
  'This repository is driven by an autonomous harness. Current position (from the generated STATE.md and HANDOFF.md; run `harness status` for the full picture):',
  section(state, '**Phase:**', '## Acceptance criteria'),
  section(handoff, '## Where things stand', '## Work in flight'),
].filter(Boolean);

// Plain stdout from a SessionStart hook is added to the session's context.
console.log(parts.join('\n\n').slice(0, 6000));
