#!/usr/bin/env node
// PreToolUse guard. Applies only to sessions the harness started (HARNESS_ROLE is set);
// a person working interactively is not restricted by it.
//
// It keeps each role inside its lane:
//   - nobody edits harness-owned or human-owned paths
//   - read-only roles (reviewer, triager) edit nothing
//   - no session edits files outside its own checkout
//   - no session moves branches around; the orchestrator owns git topology
//
// A shell command can still write anywhere, so the orchestrator re-checks the branch after every
// session and restores protected paths. This hook is the fast, friendly first line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const role = process.env.HARNESS_ROLE;
if (!role) process.exit(0);

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

// `harness doctor --live` sets HARNESS_PROBE to a file and reads back what the hooks saw.
const probe = (decision) => {
  if (!process.env.HARNESS_PROBE) return;
  try {
    const { hook_event_name: event, tool_name, agent_type, permission_mode } = input;
    fs.appendFileSync(process.env.HARNESS_PROBE, `${JSON.stringify({ hook: 'guard', event, tool: tool_name, agent_type, permission_mode, decision })}\n`);
  } catch {
    /* best effort */
  }
};
const allow = () => {
  probe('allow');
  process.exit(0);
};
const deny = (reason) => {
  probe('deny');
  console.error(`Blocked by the harness guard: ${reason}`);
  process.exit(2);
};

const projectDir = fs.realpathSync(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
const tool = input.tool_name;
const args = input.tool_input || {};

if (tool === 'Bash') {
  const cmd = String(args.command || '');
  const rules = [
    [/\bgit\s+push\b/, 'never push. The orchestrator lands work on the base branch.'],
    [/\bgit\s+rebase\b/, 'do not rebase. To take in the base branch, run `git merge <base>`.'],
    [/\bgit\s+worktree\b/, 'worktrees are managed by the orchestrator.'],
    [/\bgit\s+switch\b|\bgit\s+checkout\s+-[bB]\b/, 'stay on your task branch.'],
    [/\bgit\s+branch\s+-[dDmM]\b/, 'do not delete or rename branches.'],
  ];
  for (const [re, why] of rules) if (re.test(cmd)) deny(why);
  allow();
}

const target = args.file_path || args.notebook_path;
if (!target) allow();

let abs = path.resolve(projectDir, target);
try {
  abs = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
} catch {
  /* parent does not exist yet */
}
const rel = path.relative(projectDir, abs).split(path.sep).join('/');
if (rel.startsWith('..') || path.isAbsolute(rel)) {
  // Outside the checkout only scratch files in the temp folder are allowed.
  const tmp = fs.realpathSync(os.tmpdir());
  if (abs.startsWith(tmp + path.sep) || abs.startsWith('/tmp/')) allow();
  deny(`${target} is outside your checkout (${projectDir}). Work only inside it.`);
}

if (role === 'reviewer' || role === 'triager') deny(`the ${role} role is read-only. Report what you found in your result instead.`);

// Protected paths come from the main checkout's config, which no task branch can change.
let cfg = {};
for (const base of [process.env.HARNESS_ROOT, projectDir]) {
  if (!base) continue;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(base, '.harness', 'config.json'), 'utf8'));
    break;
  } catch {
    /* try the next location */
  }
}
const protectedGlobs = cfg.protectedPaths || ['.harness/**', '.claude/**', 'STATE.md', 'HANDOFF.md', 'docs/PRD.md'];
const claudeMdEditors = cfg.claudeMdEditors || ['planner', 'cleaner'];

const toRegex = (glob) => {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
};

if (protectedGlobs.some((g) => toRegex(g).test(rel))) {
  deny(`${rel} is owned by the harness or by the human. If it really needs to change, say so in your result (questions or discovered_issues).`);
}
if (rel === 'CLAUDE.md' && !claudeMdEditors.includes(role)) {
  deny('only the planner and the cleaner edit CLAUDE.md. Put what you learned in "lessons" in your result; the cleaner folds it in.');
}
if ((role === 'planner' || role === 'cleaner') && !(rel === 'CLAUDE.md' || rel.startsWith('docs/'))) {
  deny(`the ${role} role edits only docs/ and CLAUDE.md. Product code belongs to builder tasks.`);
}
allow();
