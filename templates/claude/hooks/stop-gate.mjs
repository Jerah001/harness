#!/usr/bin/env node
// Stop hook: the inner loop. A builder (or cleaner) session may not end while the quick gate
// fails or work is uncommitted; the failure is handed straight back to the same session, which
// still has all its context.
//
// It gives way after MAX_BLOCKS rounds in one session. The orchestrator runs the same gate again
// after the session, so nothing unverified can land either way.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BLOCKS = 3;
const role = process.env.HARNESS_ROLE;
const bin = process.env.HARNESS_BIN;
const mine = !!bin && ['builder', 'cleaner'].includes(role);
const probing = !!process.env.HARNESS_PROBE; // set by `harness doctor --live`, which reads back what the hooks saw
if (!mine && !probing) process.exit(0);

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
if (probing) {
  try {
    const { hook_event_name: event, agent_type, permission_mode } = input;
    fs.appendFileSync(process.env.HARNESS_PROBE, `${JSON.stringify({ hook: 'stop-gate', event, agent_type, permission_mode })}\n`);
  } catch {
    /* best effort */
  }
}
if (!mine) process.exit(0);
const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const counter = path.join(os.tmpdir(), `harness-stop-${input.session_id || 'unknown'}`);
let blocks = 0;
try {
  blocks = Number(fs.readFileSync(counter, 'utf8')) || 0;
} catch {
  /* first time */
}
if (blocks >= MAX_BLOCKS) process.exit(0);

const problems = [];

const gateArgs = [bin, 'gate', '--json', '--set', 'quick', '--cwd', cwd];
if (process.env.HARNESS_TASK_AREA) gateArgs.push('--area', process.env.HARNESS_TASK_AREA);
const gate = spawnSync(process.execPath, gateArgs, { cwd, encoding: 'utf8', timeout: 25 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
let result = null;
for (const line of String(gate.stdout || '').trim().split('\n').reverse()) {
  try {
    result = JSON.parse(line);
    break;
  } catch {
    /* not the JSON line */
  }
}
if (result && !result.ok) {
  const failed = result.results.filter((r) => !r.ok);
  problems.push(
    `The quick gate fails (${failed.map((r) => r.name).join(', ')}). Fix the cause, not the check:\n\n` +
      failed.map((r) => `### ${r.name}\n$ ${r.cmd}\n${r.tail || ''}`).join('\n\n'),
  );
}

const dirty = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).stdout?.trim();
if (dirty) problems.push(`There are uncommitted changes. Commit them on this branch:\n${dirty.split('\n').slice(0, 20).join('\n')}`);

if (!problems.length) process.exit(0);
fs.writeFileSync(counter, String(blocks + 1));
console.error(`${problems.join('\n\n')}\n\n(Stop check ${blocks + 1} of ${MAX_BLOCKS}. If you cannot fix this, finish with status "partial" and a precise handoff.)`);
process.exit(2);
