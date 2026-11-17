// STATE.md and HANDOFF.md are views of state.json, regenerated after every transition.
// Nothing reads them back, so they cannot drift and no session has to remember to update them.
import fs from 'node:fs';
import path from 'node:path';
import { ACTIVE_STATUSES, blockingIssues, starvedTasks, tasksOf } from './graph.mjs';
import { git, now, writeFileAtomic } from './util.mjs';

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const short = (s, n = 90) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));
const table = (head, rows) => (rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n') : '_None._');

const STOP_TEXT = {
  done: 'Every "must" criterion passes on staging and nothing blocking is open. The MVP is ready for a production decision.',
  needs_human: 'Everything that can proceed without you has been done. The items under "Do next" need a decision.',
  stalled: 'The same failures survived repeated fix cycles and replanning. More of the same is unlikely to help.',
  budget_runs: 'The session budget (limits.maxRuns) is used up.',
  budget_cost: 'The cost budget (limits.maxCostUsd) is used up.',
  budget_time: 'The time budget (limits.maxHours) is used up.',
  user_stop: 'Stopped on request.',
  interrupted: 'Interrupted. In-flight work was saved to its branches.',
  agent_runtime_error: 'Claude Code sessions kept failing to start or run (sign-in, rate limit, network or flags). No task attempts were consumed.',
  plan_invalid: 'The planner could not produce a plan that passes validation.',
  plan_failed: 'The planner sessions failed repeatedly.',
  plan_review: 'The plan is waiting for your approval (humanGates.plan).',
  verify_cycles_exhausted: 'The verification-cycle budget (limits.maxVerifyCycles) is used up.',
  main_checkout_error: 'The main checkout could not accept a merge. It must stay on the base branch with no local edits while the loop runs.',
  internal_error: 'The orchestrator hit an internal error.',
  idle: 'Nothing is left to schedule, yet the completion criteria are not met.',
};

function numbers(H) {
  const { state, cfg } = H;
  const tasks = tasksOf(state).filter((t) => t.priority === 'mvp' && t.status !== 'cancelled');
  const must = Object.values(state.acs).filter((a) => a.priority === 'must');
  return {
    merged: tasks.filter((t) => t.status === 'merged').length,
    total: tasks.length,
    mustPass: must.filter((a) => a.status === 'pass').length,
    must: must.length,
    blocking: blockingIssues(state).length,
    cost: state.counters.costUsd.toFixed(2),
    hours: ((state.counters.activeMs || 0) / 3600000).toFixed(1),
    limits: cfg.limits,
  };
}

function needsYou(H) {
  const { state } = H;
  const out = [];
  for (const q of state.inbox.filter((q) => q.status === 'open' && q.blocking)) {
    out.push(`Answer **${q.id}**${q.from?.task ? ` (blocks ${q.from.task})` : ''}: ${q.question}${q.default ? ` — suggested: ${q.default}` : ''}\n  \`harness answer ${q.id} "<your answer>"\``);
  }
  for (const t of tasksOf(state).filter((t) => t.status === 'blocked' && t.role !== 'cleaner')) {
    out.push(`**${t.id}** is blocked (${t.blocked?.reason}): ${short(t.blocked?.detail, 200)}\n  \`harness retry ${t.id} --guidance "<hint>"\` or \`harness cancel ${t.id}\``);
  }
  for (const i of Object.values(state.issues).filter((i) => i.status === 'stuck')) {
    out.push(`**${i.id}** is stuck after ${i.pastFixes.length} fix attempt(s): ${i.title}\n  Fix it by hand on the base branch, or \`harness reopen ${i.id} --guidance "<direction>"\` to let the loop try again${i.source === 'verify' ? '' : `, or \`harness dismiss ${i.id}\` if it should not hold up the launch`}.`);
  }
  for (const t of starvedTasks(state)) out.push(`**${t.id}** cannot start: it depends on a blocked task (${t.dependsOn.join(', ')}).`);
  return out;
}

function recentEvents(H, n = 15) {
  try {
    const lines = fs.readFileSync(path.join(H.dir, 'events.jsonl'), 'utf8').trim().split('\n').slice(-n);
    return lines.map((l) => {
      const { at, type, ...rest } = JSON.parse(l);
      const info = Object.entries(rest)
        .filter(([, v]) => typeof v !== 'object')
        .map(([k, v]) => `${k}=${short(v, 60)}`)
        .join(' ');
      return `- ${at.slice(11, 19)} ${type} ${info}`;
    });
  } catch {
    return [];
  }
}

export function renderState(H) {
  const { state, cfg } = H;
  const n = numbers(H);
  const sha = git(['rev-parse', '--short', cfg.project.baseBranch], H.root, { allowFail: true }).out || '-';
  const needs = needsYou(H);
  const tasks = tasksOf(state);
  const groups = [...state.milestones.map((m) => m.id), ...new Set(tasks.map((t) => t.milestone).filter((m) => !state.milestones.some((x) => x.id === m)))];
  const taskSections = groups
    .map((mid) => {
      const m = state.milestones.find((x) => x.id === mid);
      const rows = tasks.filter((t) => t.milestone === mid).map((t) => [t.id, t.status, `${t.attempt}/${cfg.limits.maxAttemptsPerTask}`, t.area, short(t.title, 70), (t.dependsOn || []).join(' ') || '-', (t.acceptance || []).join(' ') || '-']);
      return rows.length ? `### ${mid}${m?.title && m.title !== mid ? ` — ${m.title}` : ''}\n${table(['Task', 'Status', 'Try', 'Area', 'Title', 'After', 'Criteria'], rows)}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
  const threads = tasks
    .filter((t) => t.worktree && t.thread)
    .map((t) => [t.id, t.status, t.thread.sessionId, t.thread.resumes, t.branch, t.worktree]);
  const last = state.verify.history.at(-1);
  const issues = Object.values(state.issues).filter((i) => i.status !== 'closed');

  return `# STATE — ${cfg.project.name || path.basename(H.root)}

_Generated by the harness at ${now()}. Do not edit: it is overwritten after every transition._

**Phase:** ${state.phase}${state.stop ? ` (${state.stop.reason})` : ''} · **Base:** ${cfg.project.baseBranch} @ ${sha}${state.verify.stagingUrl ? ` · **Staging:** ${state.verify.stagingUrl}` : ''}
**Progress:** ${n.merged}/${n.total} tasks merged · ${n.mustPass}/${n.must} must criteria passing · ${n.blocking} blocking issue(s)
**Budget:** $${n.cost} of $${n.limits.maxCostUsd} · ${state.counters.runs} of ${n.limits.maxRuns} sessions · ${n.hours} h of ${n.limits.maxHours} h · ${state.verify.cycles} of ${n.limits.maxVerifyCycles} verify cycles

## Needs you
${needs.length ? needs.map((x) => `- ${x}`).join('\n') : 'Nothing.'}

## Acceptance criteria
${table(
  ['ID', 'Priority', 'Status', 'Tasks', 'Criterion'],
  Object.entries(state.acs).map(([id, ac]) => [
    id,
    ac.priority,
    ac.status,
    tasks
      .filter((t) => t.status !== 'cancelled' && (t.acceptance || []).includes(id))
      .map((t) => t.id)
      .join(' ') || '-',
    short(ac.text, 100),
  ]),
)}

## Tasks
${taskSections || '_No plan yet._'}

## Threads
One thread per in-flight task. \`claude --resume <session>\` opens any of them for inspection.
${table(['Task', 'Status', 'Session', 'Resumes', 'Branch', 'Worktree'], threads)}

## Merge queue
${state.mergeQueue.length ? state.mergeQueue.join(' → ') : '_Empty._'}

## Issues
${table(
  ['ID', 'Sev', 'Status', 'Seen', 'Title', 'Fix'],
  issues.map((i) => [i.id, i.severity, i.status, `${i.recurrence + 1}x`, short(i.title, 80), i.fixTasks.join(' ') || '-']),
)}

## Last verification
${
  last
    ? `${last.at} at ${String(last.sha).slice(0, 7)} — ${last.ok ? 'all steps passed' : 'failed'}\n${table(
        ['Step', 'Result'],
        (last.steps || []).map((s) => [s.name, s.skipped ? 'skipped' : s.ok ? 'ok' : 'FAILED']),
      )}${last.failing?.length ? `\nFailing: ${last.failing.join(', ')}` : ''}`
    : '_Not run yet._'
}

## Recent events
${recentEvents(H).join('\n') || '_None._'}
`;
}

export function renderHandoff(H) {
  const { state, cfg } = H;
  const n = numbers(H);
  const tasks = tasksOf(state);
  const needs = needsYou(H);
  const inFlight = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status) && t.status !== 'todo');
  const assumptions = state.inbox.filter((q) => q.status === 'open' && !q.blocking);
  const later = tasks.filter((t) => t.priority === 'later' && t.status === 'todo');
  const backlog = Object.values(state.issues).filter((i) => i.status === 'backlog' || (i.status === 'open' && !['P0', 'P1'].includes(i.severity)));
  const nits = tasks.flatMap((t) => (t.review?.nits || []).map((f) => `${t.id}: ${f.file ? `${f.file} — ` : ''}${short(f.issue, 140)}`));
  const lessons = state.lessons.filter((l) => !l.distilled);
  const stop = state.stop;

  const doNext = [];
  if (stop?.reason === 'done') {
    doNext.push(`Try the staging build${state.verify.stagingUrl ? ` at ${state.verify.stagingUrl}` : ''} and decide on the production release. That step is yours.`);
    if (later.length || backlog.length) doNext.push('Pick what to do from the post-MVP backlog below.');
  } else {
    doNext.push(...needs);
    if (stop && ['budget_runs', 'budget_cost', 'budget_time', 'verify_cycles_exhausted'].includes(stop.reason)) doNext.push('Raise the matching limit in `.harness/config.json` if you want the loop to continue.');
    if (stop?.reason === 'agent_runtime_error') doNext.push('Run `claude -p "hi"` in this folder to see the error, fix it (sign in, wait for the rate limit), then `harness run`.');
    if (stop?.reason === 'plan_review') doNext.push('Read the plan in STATE.md, then `harness approve plan` and `harness run`.');
    doNext.push('`harness run` continues from exactly this state.');
  }

  const flight = inFlight
    .map((t) => {
      const h = t.handoff || {};
      const lines = [`### ${t.id} ${t.title}`, `Status: ${t.status} · attempt ${t.attempt}/${cfg.limits.maxAttemptsPerTask} · branch \`${t.branch || '-'}\`${t.thread ? ` · session \`${t.thread.sessionId}\`` : ''}`];
      if (t.summary) lines.push(`Summary: ${t.summary}`);
      if (h.done?.length) lines.push(`Done: ${h.done.join('; ')}`);
      if (h.remaining?.length) lines.push(`Remaining: ${h.remaining.join('; ')}`);
      if (h.gotchas?.length) lines.push(`Gotchas: ${h.gotchas.join('; ')}`);
      if (h.next_step) lines.push(`Next step: ${h.next_step}`);
      if (t.lastFailure && t.status === 'rework') lines.push(`Waiting to address (${t.lastFailure.kind}): ${short(t.lastFailure.detail, 300)}`);
      return lines.join('\n');
    })
    .join('\n\n');

  const blockedText = tasks
    .filter((t) => t.status === 'blocked')
    .map((t) => {
      const h = t.handoff || {};
      const lines = [`### ${t.id} ${t.title}`, `Blocked: ${t.blocked?.reason} — ${short(t.blocked?.detail, 300)}`];
      lines.push(`Its work is kept on branch \`${t.branch || '-'}\`${t.worktree ? ` in \`${t.worktree}\`` : ''}${t.thread ? `; last session \`${t.thread.sessionId}\`` : ''}.`);
      if (h.remaining?.length) lines.push(`Remaining according to the last session: ${h.remaining.join('; ')}`);
      if (h.gotchas?.length) lines.push(`Gotchas: ${h.gotchas.join('; ')}`);
      if (t.lastFailure?.detail) lines.push(`Last failure (${t.lastFailure.kind}):\n\n\`\`\`\n${String(t.lastFailure.detail).slice(-1200)}\n\`\`\``);
      return lines.join('\n');
    })
    .join('\n\n');

  return `# HANDOFF — ${cfg.project.name || path.basename(H.root)}

_Generated by the harness at ${now()} for whoever picks this up next, a person or a fresh agent session. Do not edit._

## Where things stand
${n.merged} of ${n.total} tasks are merged and ${n.mustPass} of ${n.must} "must" criteria pass on staging. ${n.blocking} blocking issue(s) are open. Spent $${n.cost} over ${state.counters.runs} sessions.
${stop ? `\n**The loop stopped: ${stop.reason}.** ${STOP_TEXT[stop.reason] || ''}${stop.detail ? `\n\n${stop.detail}` : ''}` : '\nThe loop is running.'}

## Do next
${doNext.map((x, i) => `${i + 1}. ${x}`).join('\n')}

## Work in flight
${flight || '_Nothing in flight._'}

## Blocked work
${blockedText || '_Nothing blocked._'}

## Assumptions made without you
These were not worth stopping for. Each session went with its own suggestion; overrule any with \`harness answer <id> "<decision>"\`.
${assumptions.length ? assumptions.map((q) => `- **${q.id}**${q.from?.task ? ` (${q.from.task})` : ''}: ${q.question} → assumed: ${q.default || 'no default given'}`).join('\n') : '_None._'}

## After the MVP
${[...later.map((t) => `- Task ${t.id}: ${t.title}`), ...backlog.map((i) => `- Issue ${i.id} [${i.severity}]: ${i.title}`), ...nits.slice(0, 30).map((x) => `- Review note, ${x}`)].join('\n') || '_Nothing recorded._'}

## Lessons not yet folded into CLAUDE.md
${lessons.length ? lessons.map((l) => `- ${l.text} (${l.from})`).join('\n') : '_None._'}
`;
}

export function writeViews(H) {
  writeFileAtomic(path.join(H.root, 'STATE.md'), renderState(H));
  writeFileAtomic(path.join(H.root, 'HANDOFF.md'), renderHandoff(H));
}

export const stopText = (reason) => STOP_TEXT[reason] || reason;
