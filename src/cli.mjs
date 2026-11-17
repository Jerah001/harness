// Command line entry points.
import fs from 'node:fs';
import path from 'node:path';
import { detectClaude } from './agents.mjs';
import { HARNESS_DIR, PRESETS, loadConfig } from './config.mjs';
import { gateFailureText, runGates, runVerify } from './gates.mjs';
import { ACTIVE_STATUSES, tasksOf } from './graph.mjs';
import { init } from './init.mjs';
import { formatChecks, liveCheck } from './live.mjs';
import { preflight, runLoop } from './loop.mjs';
import { renderState, writeViews } from './render.mjs';
import { openHarness, requestStop } from './store.mjs';
import { git, now, pidAlive, readJson } from './util.mjs';
import { removeWorktree } from './worktrees.mjs';

const HELP = `harness — a gated task graph driven by a loop of headless Claude Code sessions

Setup
  harness init [--preset ${Object.keys(PRESETS).join('|')}] [--force]   install harness files into this project
  harness doctor                         check that the loop can start
  harness doctor --live                  also run two short real sessions to prove that flags, hooks,
                                         agents, permissions and resume work with your Claude Code

Run
  harness run [--max-runs N]             run the loop until the MVP is verified or it needs you
  harness stop                           finish the sessions in flight, then stop
  harness status [--json]                print the current state (same content as STATE.md)

Steer (all safe while the loop is stopped; picked up on the next \`harness run\`)
  harness inbox                          list questions from the agents
  harness answer <Q-id> "<text>"         answer one; unblocks the task that asked
  harness approve plan                   release the plan gate (humanGates.plan)
  harness retry <T-id> [--guidance "…"]  give a blocked task a fresh set of attempts
  harness cancel <T-id>                  drop a task
  harness reopen <I-id> [--guidance "…"] send a stuck issue back to triage
  harness dismiss <I-id>                 move an agent-reported issue to the backlog
  harness replan "<reason>"              ask the planner to revise the plan

Checks (also used by the loop and by hooks)
  harness gate [--set quick|full] [--area A] [--cwd DIR] [--json]
  harness verify [--json]                deploy to staging and run the e2e suite against it
  harness clean                          remove worktrees of finished tasks
`;

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else pos.push(a);
  }
  return { flags, pos };
}

function findRoot(flags) {
  if (typeof flags.root === 'string') return path.resolve(flags.root);
  if (process.env.HARNESS_ROOT && fs.existsSync(path.join(process.env.HARNESS_ROOT, HARNESS_DIR, 'config.json'))) return process.env.HARNESS_ROOT;
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, HARNESS_DIR, 'config.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) throw new Error('no .harness/config.json found here or in any parent folder. Run `harness init` first.');
    dir = up;
  }
}

function assertNotRunning(H) {
  const lock = readJson(path.join(H.runtime, 'lock'), null);
  if (lock && pidAlive(lock.pid)) throw new Error(`the loop is running (pid ${lock.pid}). Run \`harness stop\` first so your change is not overwritten.`);
}

function mutate(flags, fn) {
  const H = openHarness(findRoot(flags));
  assertNotRunning(H);
  const msg = fn(H);
  H.save();
  writeViews(H);
  console.log(msg);
  return 0;
}

const need = (v, what) => {
  if (!v || v === true) throw new Error(`missing ${what}. See \`harness help\`.`);
  return v;
};

export async function main(argv) {
  const [cmd = 'help', ...rest] = argv;
  const { flags, pos } = parseArgs(rest);

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;

    case 'init': {
      const root = typeof flags.root === 'string' ? path.resolve(flags.root) : process.cwd();
      const r = init(root, { preset: typeof flags.preset === 'string' ? flags.preset : undefined, force: !!flags.force });
      console.log(`Installed the harness (preset: ${r.preset}, base branch: ${r.branch}).`);
      if (r.done.length) console.log(`  wrote:   ${r.done.join(', ')}`);
      if (r.skipped.length) console.log(`  kept:    ${r.skipped.join(', ')} (already there; use --force to overwrite)`);
      console.log(`\nNext:\n  1. Write the product into docs/PRD.md (acceptance criteria as "- **AC-001** (must) …").\n  2. git add -A && git commit -m "chore: bootstrap harness"\n  3. harness doctor --live      (checks the setup with two short real sessions)\n  4. harness run`);
      return 0;
    }

    case 'doctor': {
      const H = openHarness(findRoot(flags));
      const caps = detectClaude(H.cfg);
      const { errors, warnings } = preflight(H, caps);
      console.log(`Claude Code: ${caps.found ? caps.version : 'not found'}`);
      for (const w of warnings) console.log(`warning: ${w}`);
      for (const e of errors) console.log(`error:   ${e}`);
      if (!flags.live) {
        console.log(errors.length ? '\nThe loop cannot start yet.' : '\nReady. Before the first run on this machine, `harness doctor --live` proves the wiring with two short real sessions. Then `harness run`.');
        return errors.length ? 1 : 0;
      }
      if (!caps.found) {
        console.log('\nThe live check needs Claude Code.');
        return 1;
      }
      console.log('\nLive wiring check: two short sessions, usually under a minute and a few cents …');
      const live = await liveCheck(H, caps);
      console.log(formatChecks(live.checks));
      console.log(`\nCost: about $${live.costUsd.toFixed(2)}. Session logs: ${live.logs.map((l) => path.relative(H.root, l)).join(', ')}`);
      const warned = live.checks.some((c) => c.level === 'warn');
      if (!live.ok) console.log('\nFix the FAIL lines before `harness run`.');
      else if (errors.length) console.log('\nThe wiring works. The loop still cannot start until the errors above are fixed.');
      else console.log(`\nThe wiring works${warned ? ' (see the warnings)' : ''}. A careful first start: \`harness run --max-runs 3\`.`);
      return live.ok && !errors.length ? 0 : 1;
    }

    case 'run': {
      const stop = await runLoop(findRoot(flags), { maxRuns: flags['max-runs'] ? Number(flags['max-runs']) : 0 });
      return stop.reason === 'done' ? 0 : 2;
    }

    case 'stop': {
      const H = openHarness(findRoot(flags));
      requestStop(H);
      console.log('Stop requested. The loop starts nothing new and exits when the sessions in flight finish.');
      return 0;
    }

    case 'status': {
      const H = openHarness(findRoot(flags));
      console.log(flags.json ? JSON.stringify(H.state, null, 2) : renderState(H));
      return 0;
    }

    case 'gate': {
      const root = findRoot(flags);
      const cfg = loadConfig(root);
      const cwd = typeof flags.cwd === 'string' ? path.resolve(flags.cwd) : process.cwd();
      const set = flags.set === 'full' ? 'full' : 'quick';
      const res = runGates(cfg, {
        set,
        area: typeof flags.area === 'string' ? flags.area : undefined,
        cwd,
        logDir: typeof flags['log-dir'] === 'string' ? flags['log-dir'] : undefined,
        onStep: (name) => process.stderr.write(`gate ${name} …\n`),
      });
      if (flags.json) console.log(JSON.stringify(res));
      else {
        for (const r of res.results) console.log(`${r.skipped ? 'skip' : r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ms ? `  (${(r.ms / 1000).toFixed(1)}s)` : ''}`);
        if (!res.ok) console.log(`\n${gateFailureText(res)}`);
        console.log(res.ok ? `\n${set} gate passed` : `\n${set} gate failed`);
      }
      return res.ok ? 0 : 1;
    }

    case 'verify': {
      const root = findRoot(flags);
      const cfg = loadConfig(root);
      const res = runVerify(cfg, {
        cwd: root,
        logDir: typeof flags['log-dir'] === 'string' ? flags['log-dir'] : path.join(root, HARNESS_DIR, 'runtime', 'logs'),
        onStep: (name) => process.stderr.write(`verify ${name} …\n`),
      });
      if (flags.json) console.log(JSON.stringify(res));
      else {
        for (const s of res.steps) console.log(`${s.skipped ? 'skip' : s.ok ? 'ok  ' : 'FAIL'}  ${s.name}`);
        for (const s of res.steps.filter((x) => !x.ok)) console.log(`\n### ${s.name}\n${s.tail || ''}`);
        if (res.acs) console.log(`\nCriteria: ${Object.entries(res.acs).map(([k, v]) => `${k}=${v}`).join('  ') || '(none found in the report)'}`);
      }
      return res.ok ? 0 : 1;
    }

    case 'inbox': {
      const H = openHarness(findRoot(flags));
      const open = H.state.inbox.filter((q) => q.status === 'open');
      if (!open.length) console.log('No open questions.');
      for (const q of open) console.log(`${q.id}${q.blocking ? ' [blocking]' : ''}${q.from?.task ? ` (${q.from.task})` : ''}: ${q.question}${q.default ? `\n    suggested: ${q.default}` : ''}`);
      return 0;
    }

    case 'answer':
      return mutate(flags, (H) => {
        const id = need(pos[0], 'question id');
        const text = need(pos.slice(1).join(' '), 'answer text');
        const q = H.state.inbox.find((x) => x.id === id);
        if (!q) throw new Error(`no question ${id}`);
        q.status = 'answered';
        q.answer = text;
        q.answeredAt = now();
        const t = q.from?.task ? H.state.tasks[q.from.task] : null;
        if (t && ['blocked', 'todo', 'rework'].includes(t.status)) {
          t.lastFailure = { kind: 'answered', detail: `Question: ${q.question}\nAnswer: ${text}`, at: now() };
          if (t.status === 'blocked') {
            t.status = t.worktree ? 'rework' : 'todo';
            t.blocked = null;
            t.attempt = Math.max(0, t.attempt - 1);
          }
        }
        return `${id} answered${t ? `; ${t.id} is ${t.status}` : ''}.`;
      });

    case 'approve':
      return mutate(flags, (H) => {
        if (pos[0] !== 'plan') throw new Error('usage: harness approve plan');
        H.state.plan.approved = true;
        return 'Plan approved. `harness run` continues.';
      });

    case 'retry':
      return mutate(flags, (H) => {
        const t = H.state.tasks[need(pos[0], 'task id')];
        if (!t) throw new Error(`no task ${pos[0]}`);
        if (t.status !== 'blocked') throw new Error(`${t.id} is ${t.status}, not blocked`);
        t.status = t.worktree ? 'rework' : 'todo';
        t.attempt = 0;
        t.blocked = null;
        t.thread = null;
        if (typeof flags.guidance === 'string') t.guidance = flags.guidance;
        t.history.push({ at: now(), event: 'retry', by: 'human' });
        return `${t.id} is ${t.status} with a fresh set of attempts.`;
      });

    case 'cancel':
      return mutate(flags, (H) => {
        const t = H.state.tasks[need(pos[0], 'task id')];
        if (!t) throw new Error(`no task ${pos[0]}`);
        if (t.status === 'merged') throw new Error(`${t.id} is already merged`);
        t.status = 'cancelled';
        H.state.mergeQueue = H.state.mergeQueue.filter((x) => x !== t.id);
        removeWorktree(H, t, { keepBranch: true });
        t.history.push({ at: now(), event: 'cancelled', by: 'human' });
        return `${t.id} cancelled. Its branch (${t.branch || 'none'}) is kept.`;
      });

    case 'reopen':
      return mutate(flags, (H) => {
        const i = H.state.issues[need(pos[0], 'issue id')];
        if (!i) throw new Error(`no issue ${pos[0]}`);
        i.status = 'open';
        i.recurrence = 0;
        i.triageAttempts = 0;
        if (!['P0', 'P1'].includes(i.severity)) i.severity = 'P1';
        if (typeof flags.guidance === 'string') i.evidence = `Direction from the person: ${flags.guidance}\n\n${i.evidence || ''}`;
        H.state.triage.pending = true;
        return `${i.id} reopened and queued for triage.`;
      });

    case 'dismiss':
      return mutate(flags, (H) => {
        const i = H.state.issues[need(pos[0], 'issue id')];
        if (!i) throw new Error(`no issue ${pos[0]}`);
        i.status = 'backlog';
        return `${i.id} moved to the backlog. It no longer holds up the launch.`;
      });

    case 'replan':
      return mutate(flags, (H) => {
        H.state.plan.needsReplan = true;
        H.state.plan.reason = pos.join(' ') || 'Requested by the person.';
        H.state.plan.replans = Math.max(0, H.state.plan.replans - 1); // a human request never counts against the budget
        return 'Replan queued for the next `harness run`.';
      });

    case 'clean': {
      const H = openHarness(findRoot(flags));
      assertNotRunning(H);
      let n = 0;
      for (const t of tasksOf(H.state)) {
        if (t.worktree && !ACTIVE_STATUSES.includes(t.status) && t.status !== 'blocked') {
          removeWorktree(H, t, { keepBranch: t.status !== 'merged' });
          n += 1;
        }
      }
      git(['worktree', 'prune'], H.root, { allowFail: true });
      H.save();
      console.log(`Removed ${n} worktree(s).`);
      return 0;
    }

    default:
      console.error(`unknown command "${cmd}"\n`);
      console.log(HELP);
      return 1;
  }
}
