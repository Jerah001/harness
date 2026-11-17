// End-to-end tests of the loop against a scripted stand-in for the `claude` CLI.
// Real git, real worktrees, real gate and verify child processes; only the model is faked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { project, threeTaskPlan } from './helpers.mjs';

test('plans, builds in parallel worktrees, recovers from gate, review and verify failures, and reaches done', async () => {
  const p = project({
    plans: [{ write: { 'docs/ARCHITECTURE.md': '# Architecture\nwritten by the planner\n' }, output: threeTaskPlan }],
    tasks: {
      'T-001': [{ write: { 'a.txt': 'BAD\n' } }, { write: { 'a.txt': 'good\n' }, lessons: ['a.txt must say good'] }],
      'T-002': [{ write: { 'b.txt': 'meh\n' } }], // passes the gates but not the acceptance criterion
      'T-003': [{ write: { 'c.txt': 'c\n' } }],
      'T-004': [{ write: { 'b.txt': 'good\n' } }], // the fix task triage creates
    },
    reviews: { 'T-002': ['request_changes', 'approve'] },
  });
  try {
    const stop = await p.run();
    const s = p.state();
    const calls = p.calls();

    assert.equal(stop.reason, 'done');
    assert.equal(s.phase, 'done');
    for (const id of ['T-001', 'T-002', 'T-003', 'T-004']) assert.equal(s.tasks[id].status, 'merged', id);
    assert.deepEqual(Object.fromEntries(Object.entries(s.acs).map(([k, v]) => [k, v.status])), { 'AC-001': 'pass', 'AC-002': 'pass', 'AC-003': 'pass' });

    // gate failure went back to the same session
    const t1 = calls.filter((c) => c.role === 'builder' && c.taskId === 'T-001');
    assert.equal(t1.length, 2);
    assert.equal(t1[1].resumed, true);
    assert.equal(t1[1].sessionId, t1[0].sessionId);
    assert.match(t1[1].prompt, /quick gate failed/i);
    assert.match(t1[1].prompt, /no-bad/);

    // review rejection went back to the builder; the second review used a fresh session
    const reviews = calls.filter((c) => c.role === 'reviewer' && c.taskId === 'T-002');
    assert.equal(reviews.length, 2);
    assert.notEqual(reviews[0].sessionId, reviews[1].sessionId);
    assert.match(calls.filter((c) => c.role === 'builder' && c.taskId === 'T-002')[1].prompt, /reviewer requested changes/i);

    // the failing criterion became an issue, triage produced a fix task, verification closed it
    const issue = Object.values(s.issues).find((i) => i.fingerprint === 'ac:AC-002');
    assert.equal(issue.status, 'closed');
    assert.equal(s.tasks['T-004'].kind, 'fix');
    assert.deepEqual(s.tasks['T-004'].acceptance, ['AC-002']);
    assert.equal(s.verify.stagingUrl, 'http://staging.test');
    assert.equal(s.verify.cycles, 3); // after M0, after the features, after the fix

    // sessions ran with the right agent, in worktrees, and builders never in the main checkout
    assert.ok(calls.filter((c) => c.role === 'builder').every((c) => c.cwd !== p.root && c.agent !== null || c.resumed));
    assert.equal(calls.find((c) => c.role === 'planner').cwd, fs.realpathSync(p.root));
    assert.ok(calls.every((c) => c.flags.includes('--json-schema') && c.flags.includes('--permission-prompts')));

    // T-002 and T-003 really overlapped in time: both started before either merged
    const events = p.read('.harness/events.jsonl').trim().split('\n').map((l) => JSON.parse(l));
    const idx = (pred) => events.findIndex(pred);
    const firstFeatureMerge = idx((e) => e.type === 'merged' && ['T-002', 'T-003'].includes(e.task));
    assert.ok(idx((e) => e.type === 'run_started' && e.kind === 'build' && e.task === 'T-002') < firstFeatureMerge);
    assert.ok(idx((e) => e.type === 'run_started' && e.kind === 'build' && e.task === 'T-003') < firstFeatureMerge);

    // cost: resumed sessions report cumulative cost; the total must still be 0.5 per call
    assert.equal(s.counters.costUsd, 0.5 * calls.length);
    assert.equal(s.counters.runs, calls.length);

    // repository ends clean: work on main, no worktrees or task branches left, nothing uncommitted
    assert.equal(p.read('a.txt'), 'good\n');
    assert.equal(p.read('b.txt'), 'good\n');
    assert.match(p.read('docs/ARCHITECTURE.md'), /written by the planner/);
    assert.equal(p.worktrees(), 0);
    assert.equal(p.git('branch', '--list', 'task/*'), '');
    assert.equal(p.git('status', '--porcelain'), '');
    assert.match(p.git('log', '--oneline'), /T-004: Fix I-001/);

    // generated views
    assert.match(p.read('STATE.md'), /\*\*Phase:\*\* done/);
    assert.match(p.read('STATE.md'), /2\/2 must criteria passing/);
    assert.match(p.read('HANDOFF.md'), /production release/);
    assert.match(p.read('HANDOFF.md'), /a\.txt must say good/); // lesson waiting for the cleaner
  } finally {
    p.cleanup();
  }
});

test('a task that exhausts its attempts is replanned once, then succeeds with a fresh session', async () => {
  const p = project(
    {
      plans: [
        { output: { ...threeTaskPlan, tasks: threeTaskPlan.tasks.slice(0, 2) } },
        { output: { summary: 'Retry A differently.', tasks: [], retry: [{ id: 'T-001', guidance: 'write good, not BAD' }] } },
      ],
      tasks: {
        'T-001': [{ write: { 'a.txt': 'BAD\n' } }, { write: { 'a.txt': 'BAD\n' } }, { write: { 'a.txt': 'good\n' } }],
        'T-002': [{ write: { 'b.txt': 'good\n' } }],
      },
    },
    { limits: { maxAttemptsPerTask: 2 } },
    { prd: '- **AC-001** (must) a\n- **AC-002** (must) b\n' },
  );
  try {
    const stop = await p.run();
    const s = p.state();
    const builds = p.calls().filter((c) => c.role === 'builder' && c.taskId === 'T-001');
    assert.equal(stop.reason, 'done');
    assert.equal(s.plan.replans, 1);
    assert.equal(s.tasks['T-001'].replanned, 1);
    assert.equal(builds.length, 3);
    assert.equal(builds[2].resumed, false); // new approach, new context
    assert.notEqual(builds[2].sessionId, builds[0].sessionId);
    assert.match(builds[2].prompt, /write good, not BAD/);
    assert.match(p.calls().filter((c) => c.role === 'planner')[1].prompt, /Blocked tasks/);
  } finally {
    p.cleanup();
  }
});

test('stops and asks for a person when nothing more can be done, then continues after `harness retry`', async () => {
  const stuck = { plans: [{ output: { ...threeTaskPlan, tasks: threeTaskPlan.tasks.slice(0, 1) } }], tasks: { 'T-001': [{ write: { 'a.txt': 'BAD\n' } }] } };
  const p = project(stuck, { limits: { maxAttemptsPerTask: 2, maxReplans: 0 } }, { prd: '- **AC-001** (must) a\n' });
  try {
    const stop = await p.run();
    assert.equal(stop.reason, 'needs_human');
    assert.equal(p.state().tasks['T-001'].status, 'blocked');
    assert.match(p.read('HANDOFF.md'), /harness retry T-001/);
    assert.equal(p.worktrees(), 1); // the blocked task keeps its worktree and its work

    p.setScenario({ ...stuck, tasks: { 'T-001': [{ write: { 'a.txt': 'good\n' } }] } });
    assert.match(p.cli('retry', 'T-001', '--guidance', 'say good'), /fresh set of attempts/);
    const again = await p.run();
    assert.equal(again.reason, 'done');
    assert.equal(p.read('a.txt'), 'good\n');
  } finally {
    p.cleanup();
  }
});

test('a merge conflict goes back to the builder and lands without a second review', async () => {
  const plan = {
    summary: 'Two tasks that both create shared.txt.',
    tasks: [
      { key: 'x', title: 'X', description: 'x', area: 'web', acceptance: ['AC-001'], touches: ['x/**'] },
      { key: 'y', title: 'Y', description: 'y', area: 'server', acceptance: ['AC-001'], touches: ['y/**'] },
    ],
  };
  const p = project(
    {
      plans: [{ output: plan }],
      tasks: {
        // Whichever lands second hits the conflict; its second session merges the base branch and resolves it.
        'T-001': [{ write: { 'shared.txt': 'one\n', 'a.txt': 'good\n' } }, { mergeBase: true, write: { 'shared.txt': 'one\ntwo\n' } }],
        'T-002': [{ write: { 'shared.txt': 'two\n' } }, { mergeBase: true, write: { 'shared.txt': 'one\ntwo\n' } }],
      },
    },
    {},
    { prd: '- **AC-001** (must) a\n' },
  );
  try {
    const stop = await p.run();
    const s = p.state();
    assert.equal(stop.reason, 'done');
    assert.equal(p.read('shared.txt'), 'one\ntwo\n');
    const losers = ['T-001', 'T-002'].filter((id) => s.tasks[id].history.some((h) => h.event === 'rework' && h.reason === 'conflict'));
    assert.equal(losers.length, 1); // which one depends on timing; exactly one must lose
    const [loser] = losers;
    assert.equal(p.calls().filter((c) => c.role === 'reviewer' && c.taskId === loser).length, 1);
    const retry = p.calls().filter((c) => c.role === 'builder' && c.taskId === loser)[1];
    assert.equal(retry.resumed, true);
    assert.match(retry.prompt, /git merge main[\s\S]*shared\.txt/);
    assert.equal(p.read('a.txt'), 'good\n');
  } finally {
    p.cleanup();
  }
});

test('repeated session failures stop the loop without burning task attempts', async () => {
  const p = project(
    { plans: [{ output: { ...threeTaskPlan, tasks: threeTaskPlan.tasks.slice(0, 1) } }], tasks: { 'T-001': [{ fail: 'infra' }] } },
    {},
    { prd: '- **AC-001** (must) a\n' },
  );
  try {
    const stop = await p.run();
    assert.equal(stop.reason, 'agent_runtime_error');
    assert.match(stop.detail, /401/);
    assert.equal(p.state().tasks['T-001'].attempt, 0);
    assert.equal(p.state().tasks['T-001'].status, 'todo');
  } finally {
    p.cleanup();
  }
});

test('an interrupted run resumes from saved state, including a session that died mid-build', async () => {
  const p = project({
    plans: [{ output: threeTaskPlan }],
    tasks: { 'T-001': [{ write: { 'a.txt': 'good\n' } }], 'T-002': [{ write: { 'b.txt': 'good\n' } }], 'T-003': [{ write: { 'c.txt': 'c\n' } }] },
  });
  try {
    const first = await p.run({ maxRuns: 2 }); // planner + one builder, then a graceful stop
    assert.equal(first.reason, 'user_stop');
    const mid = p.state();
    assert.equal(mid.tasks['T-001'].status, 'built');

    // simulate a crash: the state file says a session is still building
    mid.tasks['T-001'].status = 'building';
    mid.tasks['T-001'].attempt = 2;
    fs.writeFileSync(path.join(p.root, '.harness', 'state.json'), JSON.stringify(mid));

    const second = await p.run();
    const s = p.state();
    assert.equal(second.reason, 'done');
    assert.ok(Object.values(s.tasks).every((t) => t.status === 'merged'));
    const t1 = p.calls().filter((c) => c.role === 'builder' && c.taskId === 'T-001');
    assert.equal(t1.at(-1).resumed, true); // picked the dead session back up
    assert.match(t1.at(-1).prompt, /interrupted/);
  } finally {
    p.cleanup();
  }
});

test('the cleaner is scheduled after enough merges and its lessons are marked as folded in', async () => {
  const p = project(
    {
      plans: [{ output: { ...threeTaskPlan, tasks: threeTaskPlan.tasks.slice(0, 2) } }],
      tasks: {
        'T-001': [{ write: { 'a.txt': 'good\n' }, lessons: ['always say good'] }],
        'T-002': [{ write: { 'b.txt': 'good\n' } }],
        'T-003': [{ write: { 'docs/NOTES.md': 'tidied\n' } }],
      },
    },
    { limits: { cleanEveryMerges: 2 } },
    { prd: '- **AC-001** (must) a\n- **AC-002** (must) b\n' },
  );
  try {
    const stop = await p.run();
    const s = p.state();
    assert.equal(stop.reason, 'done');
    assert.equal(s.tasks['T-003'].role, 'cleaner');
    assert.equal(s.tasks['T-003'].status, 'merged');
    const cleanerCall = p.calls().find((c) => c.role === 'cleaner');
    assert.equal(cleanerCall.agent, 'cleaner');
    assert.match(cleanerCall.prompt, /always say good/);
    assert.ok(s.lessons.every((l) => l.distilled));
  } finally {
    p.cleanup();
  }
});

const onlyA = { ...threeTaskPlan, tasks: threeTaskPlan.tasks.slice(0, 1) };
const prdA = { prd: '- **AC-001** (must) a\n' };

test('an invalid plan is sent back to the same planner session, and the plan gate waits for approval', async () => {
  const p = project(
    { plans: [{ output: onlyA }, { output: { ...threeTaskPlan, tasks: threeTaskPlan.tasks.slice(0, 2) } }], tasks: { 'T-001': [{ write: { 'a.txt': 'good\n' } }], 'T-002': [{ write: { 'b.txt': 'good\n' } }] } },
    { humanGates: { plan: true } },
    { prd: '- **AC-001** (must) a\n- **AC-002** (must) b\n' },
  );
  try {
    const first = await p.run();
    const planners = p.calls().filter((c) => c.role === 'planner');
    assert.equal(first.reason, 'plan_review');
    assert.equal(planners.length, 2);
    assert.equal(planners[1].resumed, true);
    assert.match(planners[1].prompt, /rejected by validation[\s\S]*AC-002 \(must\) is not covered/);
    assert.equal(Object.keys(p.state().tasks).length, 2); // only the valid plan was applied
    assert.equal(p.calls().filter((c) => c.role === 'builder').length, 0); // nothing built before approval

    assert.match(p.cli('approve', 'plan'), /approved/);
    assert.equal((await p.run()).reason, 'done');
  } finally {
    p.cleanup();
  }
});

test('a blocking question stops only that task; the answer reaches the next session', async () => {
  const p = project(
    {
      plans: [{ output: onlyA }],
      tasks: {
        'T-001': [
          { commit: false, output: { status: 'blocked', summary: 'Cannot choose a provider.', questions: [{ question: 'Which payment provider?', default: 'none', blocking: true }] } },
          { write: { 'a.txt': 'good\n' } },
        ],
      },
    },
    {},
    prdA,
  );
  try {
    assert.equal((await p.run()).reason, 'needs_human');
    assert.equal(p.state().tasks['T-001'].blocked.reason, 'needs_human');
    assert.match(p.cli('inbox'), /Q-001 \[blocking\] \(T-001\): Which payment provider\?/);
    assert.match(p.read('HANDOFF.md'), /harness answer Q-001/);

    p.cli('answer', 'Q-001', 'Stripe, test mode only');
    assert.equal((await p.run()).reason, 'done');
    assert.match(p.calls().filter((c) => c.role === 'builder').at(-1).prompt, /Answer: Stripe, test mode only/);
  } finally {
    p.cleanup();
  }
});

test('a failing deploy step becomes an issue, gets a fix task, and closes when verification passes', async () => {
  const p = project(
    { plans: [{ output: onlyA }], tasks: { 'T-001': [{ write: { 'a.txt': 'good\n' } }], 'T-002': [{ write: { 'deploy-ok': 'yes\n' } }] } },
    {
      verify: {
        steps: [
          { name: 'deploy', cmd: 'test -f deploy-ok && echo STAGING_URL=http://staging.test', capture: { STAGING_URL: 'STAGING_URL=(\\S+)' } },
          { name: 'e2e', cmd: 'node e2e.mjs', acReport: true },
        ],
      },
    },
    prdA,
  );
  try {
    assert.equal((await p.run()).reason, 'done');
    const s = p.state();
    const issue = Object.values(s.issues).find((i) => i.fingerprint === 'step:deploy');
    assert.equal(issue.status, 'closed');
    assert.deepEqual(issue.fixTasks, ['T-002']);
    assert.equal(s.verify.cycles, 2);
    assert.match(p.calls().find((c) => c.role === 'triager').prompt, /Verification step "deploy" fails/);
  } finally {
    p.cleanup();
  }
});

test('a failure that survives its fixes is declared stuck, and `harness reopen` puts it back in play', async () => {
  const scenario = { plans: [{ output: onlyA }], tasks: { 'T-001': [{ write: { 'a.txt': 'meh\n' } }] } }; // gates pass, the criterion never does
  const p = project(scenario, { limits: { maxIssueRecurrence: 2, stallCycles: 9 } }, prdA);
  try {
    const stop = await p.run();
    const s = p.state();
    const issue = Object.values(s.issues)[0];
    assert.equal(stop.reason, 'needs_human');
    assert.equal(issue.status, 'stuck');
    assert.deepEqual(issue.pastFixes, ['T-002', 'T-003']); // two fixes landed, neither helped
    assert.match(p.calls().filter((c) => c.role === 'triager')[1].prompt, /Earlier fixes that did not resolve it[\s\S]*T-002/);
    assert.match(p.read('HANDOFF.md'), /harness reopen I-001/);

    p.setScenario({ ...scenario, tasks: { ...scenario.tasks, 'T-004': [{ write: { 'a.txt': 'good\n' } }] } });
    p.cli('reopen', 'I-001', '--guidance', 'the file must say good');
    assert.equal((await p.run()).reason, 'done');
    assert.match(p.calls().filter((c) => c.role === 'triager').at(-1).prompt, /Direction from the person: the file must say good/);
  } finally {
    p.cleanup();
  }
});

test('the loop stops as stalled when the same failures survive verification cycles and no replans are left', async () => {
  const p = project(
    { plans: [{ output: onlyA }], tasks: { 'T-001': [{ write: { 'a.txt': 'meh\n' } }] } },
    { limits: { maxIssueRecurrence: 9, stallCycles: 1, maxReplans: 0 } },
    prdA,
  );
  try {
    const stop = await p.run();
    assert.equal(stop.reason, 'stalled');
    assert.match(stop.detail, /ac:AC-001/);
    assert.equal(p.state().verify.cycles, 2);
  } finally {
    p.cleanup();
  }
});

test('a session that returns partial hands over to a fresh session instead of being resumed', async () => {
  const p = project(
    {
      plans: [{ output: onlyA }],
      tasks: {
        'T-001': [
          { write: { 'a.txt': 'half\n' }, output: { status: 'partial', summary: 'Got halfway.', handoff: { done: ['created a.txt'], remaining: ['make a.txt say good'], gotchas: ['the gate greps for BAD'], next_step: 'write good' } } },
          { write: { 'a.txt': 'good\n' } },
        ],
      },
    },
    {},
    prdA,
  );
  try {
    assert.equal((await p.run()).reason, 'done');
    const builds = p.calls().filter((c) => c.role === 'builder');
    assert.equal(builds.length, 2);
    assert.equal(builds[1].resumed, false);
    assert.match(builds[1].prompt, /stopped before the task was complete/);
    assert.match(builds[1].prompt, /Handoff from the previous session[\s\S]*make a\.txt say good[\s\S]*the gate greps for BAD[\s\S]*Suggested next step: write good/);
    assert.equal(p.calls().filter((c) => c.role === 'reviewer').length, 1); // unfinished work was not sent to review
  } finally {
    p.cleanup();
  }
});

test('a serious problem reported by an agent gets a fix task and closes when it lands; the rest go to the backlog', async () => {
  const p = project(
    {
      plans: [{ output: onlyA }],
      tasks: {
        'T-001': [
          {
            write: { 'a.txt': 'good\n' },
            discovered_issues: [
              { title: 'Quote name is rendered unescaped', severity: 'P1', detail: 'XSS' },
              { title: 'Second serious thing', severity: 'P1' },
              { title: 'Button colour is off', severity: 'P3' },
            ],
          },
        ],
      },
    },
    { limits: { maxDiscoveredFixes: 1 } },
    prdA,
  );
  try {
    assert.equal((await p.run()).reason, 'done');
    const s = p.state();
    const byTitle = (t) => Object.values(s.issues).find((i) => i.title.startsWith(t));
    assert.equal(byTitle('Quote name').status, 'closed');
    assert.equal(s.tasks[byTitle('Quote name').fixTasks[0]].status, 'merged');
    assert.equal(byTitle('Second serious').status, 'backlog'); // over the budget for agent-reported fixes
    assert.equal(byTitle('Button colour').status, 'backlog');
    assert.match(p.read('HANDOFF.md'), /After the MVP[\s\S]*Second serious thing[\s\S]*Button colour is off/);
  } finally {
    p.cleanup();
  }
});

test('a criterion added to the PRD after planning triggers a replan on the next run', async () => {
  const p = project(
    {
      plans: [{ output: onlyA }, { output: { summary: 'Cover the new criterion.', tasks: [{ key: 'b', title: 'Feature B', description: 'make b', area: 'server', acceptance: ['AC-002'], touches: ['b.txt'] }] } }],
      tasks: { 'T-001': [{ write: { 'a.txt': 'good\n' } }], 'T-002': [{ write: { 'b.txt': 'good\n' } }] },
    },
    {},
    prdA,
  );
  try {
    assert.equal((await p.run()).reason, 'done');
    fs.appendFileSync(path.join(p.root, 'docs', 'PRD.md'), '- **AC-002** (must) b\n');
    p.git('commit', '-qam', 'docs: add AC-002');
    assert.equal((await p.run()).reason, 'done');
    const s = p.state();
    assert.equal(s.acs['AC-002'].status, 'pass');
    assert.match(p.calls().filter((c) => c.role === 'planner')[1].prompt, /No task covers AC-002/);
  } finally {
    p.cleanup();
  }
});
