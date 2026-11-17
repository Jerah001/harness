// Unit tests for the pure parts (graph, report parsing) and for the hook scripts.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseAcReport } from '../src/gates.mjs';
import { applyPlan, expectedAcs, isDone, newTask, parsePrd, pickDispatch, syncAcs, upsertFailure, validatePlan } from '../src/graph.mjs';
import { init } from '../src/init.mjs';
import { emptyState } from '../src/store.mjs';
import { globsOverlap, readJson } from '../src/util.mjs';
import { BIN, HERE, project, threeTaskPlan } from './helpers.mjs';

const HOOKS = path.join(HERE, '..', 'templates', 'claude', 'hooks');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-unit-'));

test('parsePrd reads ids, priorities and text from the common ways of writing a criterion', () => {
  const acs = parsePrd(`
- **AC-001** (must) User can sign in
- [ ] AC-002 [should]: Sees a list
* **AC-003**: defaults to must
| AC-004 | (could) | in a table |
Mentioning AC-009 in prose defines nothing.
    - **AC-NNN** (must) the template placeholder is ignored
- **AC-001** (could) a duplicate does not override the first
`);
  assert.deepEqual(Object.keys(acs), ['AC-001', 'AC-002', 'AC-003', 'AC-004']);
  assert.deepEqual(acs['AC-001'], { text: 'User can sign in', priority: 'must' });
  assert.deepEqual(acs['AC-002'], { text: 'Sees a list', priority: 'should' });
  assert.equal(acs['AC-003'].priority, 'must');
  assert.equal(acs['AC-004'].priority, 'could');
});

test('validatePlan rejects cycles, dangling references, unknown criteria and uncovered must criteria', () => {
  const state = emptyState();
  syncAcs(state, parsePrd('- **AC-001** (must) a\n- **AC-002** (must) b\n'));
  const task = (key, extra = {}) => ({ key, title: key, description: key, area: 'web', ...extra });
  assert.deepEqual(validatePlan(state, { tasks: [task('a', { acceptance: ['AC-001'] }), task('b', { acceptance: ['AC-002'], depends_on: ['a'] })] }), []);

  const errs = validatePlan(state, {
    tasks: [
      task('a', { acceptance: ['AC-001'], depends_on: ['b'] }),
      task('b', { depends_on: ['a', 'ghost'], acceptance: ['AC-404'] }),
      task('a'),
      { key: 'c', title: 'c', description: 'c', area: 'kitchen' },
    ],
  }).join('\n');
  assert.match(errs, /Dependency cycle/);
  assert.match(errs, /"ghost" matches no task/);
  assert.match(errs, /unknown acceptance criterion AC-404/);
  assert.match(errs, /key "a" is not unique/);
  assert.match(errs, /area must be one of/);
  assert.match(errs, /AC-002 \(must\) is not covered/);
});

test('applyPlan assigns ids, resolves keys, and a cancel plus replacement keeps criteria covered', () => {
  const state = emptyState();
  syncAcs(state, parsePrd('- **AC-001** (must) a\n'));
  applyPlan(state, { milestones: [{ id: 'M0', title: 'Skeleton' }], tasks: [{ key: 'a', title: 'A', description: 'a', area: 'web', acceptance: ['AC-001'] }, { key: 'b', title: 'B', description: 'b', area: 'server', depends_on: ['a'] }] });
  assert.deepEqual(state.tasks['T-002'].dependsOn, ['T-001']);
  state.tasks['T-001'].status = 'blocked';
  assert.match(validatePlan(state, { tasks: [], cancel: ['T-001'] }).join('\n'), /AC-001 \(must\) is not covered/);
  const replan = { tasks: [{ key: 'a2', title: 'A again', description: 'a', area: 'web', acceptance: ['AC-001'] }], cancel: ['T-001'] };
  assert.deepEqual(validatePlan(state, replan), []);
  const r = applyPlan(state, replan);
  assert.deepEqual(r.cancelled, ['T-001']);
  assert.equal(state.tasks['T-003'].title, 'A again');
});

test('pickDispatch keeps overlapping tasks apart, respects dependencies, and finishes rework first', () => {
  const state = emptyState();
  state.milestones = [{ id: 'M0' }];
  const a = newTask(state, { title: 'a', area: 'web', touches: ['web/app/quotes/**'] });
  const b = newTask(state, { title: 'b', area: 'web', touches: ['web/app/**'] }); // overlaps a
  const c = newTask(state, { title: 'c', area: 'server', touches: ['server/**'] });
  const d = newTask(state, { title: 'd', area: 'server', touches: ['server/src/db/**'], dependsOn: [c.id] });
  assert.deepEqual(pickDispatch(state, 4).map((t) => t.id), [a.id, c.id]);
  a.status = 'building';
  assert.deepEqual(pickDispatch(state, 4).map((t) => t.id), [c.id]); // b still waits for a
  a.status = 'merged';
  c.status = 'merged';
  d.status = 'rework';
  assert.deepEqual(pickDispatch(state, 1).map((t) => t.id), [d.id]); // work in progress before new work
  assert.equal(globsOverlap(['web/**'], ['server/**']), false);
  assert.equal(globsOverlap(['package.json'], ['package.json']), true);
  assert.equal(globsOverlap(['**'], ['docs/x.md']), true);
});

test('criteria are only expected to pass once every task that covers them has merged', () => {
  const state = emptyState();
  syncAcs(state, parsePrd('- **AC-001** (must) a\n- **AC-002** (should) b\n'));
  const a = newTask(state, { title: 'a', area: 'web', acceptance: ['AC-001'] });
  const b = newTask(state, { title: 'b', area: 'web', acceptance: ['AC-001', 'AC-002'] });
  a.status = 'merged';
  assert.deepEqual(expectedAcs(state), []);
  b.status = 'merged';
  assert.deepEqual(expectedAcs(state), ['AC-001', 'AC-002']);
  state.acs['AC-001'].status = 'pass';
  assert.equal(isDone(state), true); // a failing "should" criterion never holds up the launch
});

test('a failure that survives its fixes becomes stuck after the configured number of recurrences', () => {
  const state = emptyState();
  const spec = { title: 'AC-001 fails', severity: 'P0', evidence: 'x', acceptance: ['AC-001'] };
  const issue = upsertFailure(state, 'ac:AC-001', spec, 2);
  for (let round = 1; round <= 2; round++) {
    const fix = newTask(state, { title: `fix ${round}`, area: 'web', kind: 'fix' });
    issue.fixTasks.push(fix.id);
    upsertFailure(state, 'ac:AC-001', spec, 2); // fix still in flight: nothing changes
    assert.equal(issue.recurrence, round - 1);
    fix.status = 'merged';
    upsertFailure(state, 'ac:AC-001', spec, 2); // fix landed and it still fails
    assert.equal(issue.recurrence, round);
  }
  assert.equal(issue.status, 'stuck');
  assert.equal(issue.pastFixes.length, 2);
});

test('parseAcReport maps Playwright results to criteria and never counts a skipped test as a pass', () => {
  const dir = tmp();
  const file = path.join(dir, 'report.json');
  const spec = (title, ok, status) => ({ title, ok, tests: [{ status }] });
  fs.writeFileSync(
    file,
    JSON.stringify({
      suites: [
        {
          title: 'quotes.spec.ts',
          specs: [spec('AC-001: creates a quote', true, 'expected'), spec('AC-002: lists quotes', false, 'unexpected'), spec('AC-003: exports', true, 'skipped')],
          suites: [{ title: 'AC-004 pricing rules', specs: [spec('applies tax', true, 'expected'), spec('rounds half up', true, 'flaky')] }, { title: 'mixed', specs: [spec('AC-001 and AC-005 together', false, 'unexpected')] }],
        },
      ],
    }),
  );
  assert.deepEqual(parseAcReport(file), { 'AC-001': 'fail', 'AC-002': 'fail', 'AC-003': 'fail', 'AC-004': 'pass', 'AC-005': 'fail' });
  fs.writeFileSync(file, JSON.stringify({ 'AC-001': true, 'AC-002': 'fail' }));
  assert.deepEqual(parseAcReport(file, 'map'), { 'AC-001': 'pass', 'AC-002': 'fail' });
  fs.rmSync(dir, { recursive: true });
});

function hook(name, { env = {}, input = {}, cwd }) {
  const r = spawnSync(process.execPath, [path.join(HOOKS, name)], { input: JSON.stringify(input), encoding: 'utf8', cwd, env: { ...process.env, HARNESS_ROLE: '', HARNESS_BIN: '', HARNESS_ROOT: '', ...env } });
  return { code: r.status, err: r.stderr, out: r.stdout };
}

test('guard hook: each role stays in its lane, and people are not restricted', () => {
  const dir = fs.realpathSync(tmp());
  const edit = (role, rel, tool = 'Edit') => hook('guard.mjs', { env: { HARNESS_ROLE: role, CLAUDE_PROJECT_DIR: dir }, input: { tool_name: tool, tool_input: { file_path: path.resolve(dir, rel) }, cwd: dir } });
  const bash = (role, command) => hook('guard.mjs', { env: { HARNESS_ROLE: role, CLAUDE_PROJECT_DIR: dir }, input: { tool_name: 'Bash', tool_input: { command }, cwd: dir } });

  assert.equal(edit('builder', 'web/app/page.tsx').code, 0);
  assert.equal(edit('builder', 'docs/decisions/T-001-x.md').code, 0);
  for (const rel of ['.harness/config.json', '.claude/settings.json', 'STATE.md', 'docs/PRD.md', 'CLAUDE.md']) assert.equal(edit('builder', rel).code, 2, rel);
  assert.match(edit('builder', 'CLAUDE.md').err, /lessons/);
  assert.equal(edit('builder', '/opt/main-checkout/web/app/page.tsx').code, 2); // another checkout
  assert.equal(edit('builder', path.join(os.tmpdir(), 'scratch.txt'), 'Write').code, 0); // scratch space is fine

  assert.equal(edit('cleaner', 'CLAUDE.md').code, 0);
  assert.equal(edit('cleaner', 'web/app/page.tsx').code, 2);
  assert.equal(edit('planner', 'docs/ARCHITECTURE.md').code, 0);
  assert.equal(edit('planner', 'docs/PRD.md').code, 2);
  assert.equal(edit('reviewer', 'web/app/page.tsx').code, 2);

  assert.equal(bash('builder', 'pnpm -C web run lint && git commit -am "T-001: x"').code, 0);
  assert.equal(bash('builder', 'git merge main').code, 0);
  for (const cmd of ['git push origin main', 'git rebase main', 'git switch main', 'git checkout -b other', 'git worktree add ../x', 'git branch -D task/T-002']) assert.equal(bash('builder', cmd).code, 2, cmd);

  assert.equal(edit('', '.harness/config.json').code, 0); // an interactive human session
  assert.equal(bash('', 'git push').code, 0);
  fs.rmSync(dir, { recursive: true });
});

test('stop hook: sends gate failures and uncommitted work back to the session, then gives way', () => {
  const p = project({ plans: [{ output: threeTaskPlan }] });
  try {
    const run = (role, session = 's1') => hook('stop-gate.mjs', { cwd: p.root, env: { HARNESS_ROLE: role, HARNESS_BIN: BIN, HARNESS_ROOT: p.root, CLAUDE_PROJECT_DIR: p.root }, input: { session_id: `${session}-${process.pid}`, cwd: p.root } });
    assert.equal(run('builder').code, 0); // clean tree, gate passes
    fs.writeFileSync(path.join(p.root, 'oops.txt'), 'BAD\n');
    const blocked = run('builder');
    assert.equal(blocked.code, 2);
    assert.match(blocked.err, /quick gate fails \(no-bad\)/);
    assert.match(blocked.err, /uncommitted changes/);
    assert.match(blocked.err, /Stop check 1 of 3/);
    assert.equal(run('reviewer').code, 0); // only roles that write are held
    assert.equal(run('builder').code, 2);
    assert.equal(run('builder').code, 2);
    assert.equal(run('builder').code, 0); // fourth time: gives way, the orchestrator's gate is the backstop
  } finally {
    p.cleanup();
  }
});

test('session-start hook: briefs an interactive session from the generated files, stays silent for harness sessions', async () => {
  const p = project({ plans: [{ output: { ...threeTaskPlan, tasks: threeTaskPlan.tasks.slice(0, 1) } }], tasks: { 'T-001': [{ write: { 'a.txt': 'BAD\n' } }] } }, { limits: { maxAttemptsPerTask: 1, maxReplans: 0 } }, { prd: '- **AC-001** (must) a\n' });
  try {
    await p.run();
    const human = hook('session-context.mjs', { cwd: p.root, env: { CLAUDE_PROJECT_DIR: p.root } });
    assert.match(human.out, /autonomous harness/);
    assert.match(human.out, /needs_human/);
    assert.match(human.out, /harness retry T-001/);
    assert.equal(hook('session-context.mjs', { cwd: p.root, env: { CLAUDE_PROJECT_DIR: p.root, HARNESS_ROLE: 'builder' } }).out, '');
  } finally {
    p.cleanup();
  }
});

test('init merges into an existing project instead of overwriting it', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(make *)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, model: 'opus' }));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Mine\nKeep this.\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  init(dir, {});
  const s = readJson(path.join(dir, '.claude', 'settings.json'));
  assert.equal(s.model, 'opus');
  assert.ok(s.permissions.allow.includes('Bash(make *)') && s.permissions.allow.includes('Bash(cargo *)'));
  assert.equal(s.hooks.Stop.length, 2);
  const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(md, /^# Mine\nKeep this\./);
  assert.match(md, /harness:rules:start/);
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /node_modules\/\n[\s\S]*STATE\.md/);
  const cfg = readJson(path.join(dir, '.harness', 'config.json'));
  assert.equal(cfg.gates.find((g) => g.name === 'server:clippy').quick, true);
  for (const f of ['.claude/agents/builder.md', '.claude/hooks/guard.mjs', 'docs/PRD.md', 'docs/CONTRACTS.md', 'docs/decisions/README.md']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  const before = fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8');
  init(dir, {}); // running it twice changes nothing
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'), before);
  fs.rmSync(dir, { recursive: true });
});

test('Ctrl+C stops the children, saves the work, and the next run picks the task back up', async () => {
  const slow = { plans: [{ output: { ...threeTaskPlan, tasks: threeTaskPlan.tasks.slice(0, 1) } }], tasks: { 'T-001': [{ sleepMs: 60000, write: { 'a.txt': 'good\n' } }] } };
  const p = project(slow, {}, { prd: '- **AC-001** (must) a\n' });
  try {
    const scenarioFile = path.join(path.dirname(p.root), 'scenario.json');
    const child = spawn(process.execPath, [BIN, 'run'], { cwd: p.root, stdio: 'ignore', env: { ...process.env, FAKE_SCENARIO: scenarioFile, FAKE_STATE: path.join(path.dirname(p.root), 'fake-state') } });
    const exited = new Promise((resolve) => child.on('close', resolve));
    const events = path.join(p.root, '.harness', 'events.jsonl');
    for (let i = 0; i < 200; i++) {
      if (fs.existsSync(events) && /"kind":"build"/.test(fs.readFileSync(events, 'utf8'))) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    fs.writeFileSync(path.join(p.state().tasks['T-001'].worktree, 'half-done.txt'), 'work in progress\n');
    child.kill('SIGINT');
    assert.equal(await exited, 2);

    const s = p.state();
    assert.equal(s.stop.reason, 'interrupted');
    assert.equal(s.tasks['T-001'].status, 'rework');
    assert.equal(s.tasks['T-001'].attempt, 0);
    assert.equal(s.tasks['T-001'].lastFailure.kind, 'interrupted');
    assert.equal(fs.existsSync(path.join(p.root, '.harness', 'runtime', 'lock')), false);
    assert.match(p.git('log', '--oneline', 'task/T-001'), /save interrupted work/); // nothing lost

    p.setScenario({ ...slow, tasks: { 'T-001': [{ write: { 'a.txt': 'good\n' } }] } });
    assert.equal((await p.run()).reason, 'done');
    assert.equal(p.read('half-done.txt'), 'work in progress\n');
  } finally {
    p.cleanup();
  }
});

test('doctor refuses to start when harness files exist but are not committed, since worktrees would not have them', () => {
  const p = project({ plans: [] });
  try {
    assert.equal(p.cliResult('doctor').code, 0);
    p.git('rm', '-q', '--cached', '.claude/settings.json', '.claude/agents/builder.md');
    p.git('commit', '-qm', 'chore: forget two harness files');
    const r = p.cliResult('doctor');
    assert.equal(r.code, 1);
    assert.match(r.out, /Not committed: \.claude\/settings\.json, \.claude\/agents\/builder\.md\. Task worktrees are created from the main branch/);
  } finally {
    p.cleanup();
  }
});
