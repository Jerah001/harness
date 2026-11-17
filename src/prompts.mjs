// The dynamic brief each session receives. Stable role instructions live in .claude/agents/*.md;
// everything here is computed from state, so a fresh session needs no memory of earlier ones.
import { blockingIssues, tasksOf } from './graph.mjs';
import { worktreeEnv } from './worktrees.mjs';

const list = (items, empty = '- (none)') => (items?.length ? items.map((i) => `- ${i}`).join('\n') : empty);
const fence = (text) => `\`\`\`\n${String(text || '').trim()}\n\`\`\``;
const acLine = (state, id) => {
  const ac = state.acs[id];
  return ac ? `${id} (${ac.priority}, currently ${ac.status}): ${ac.text}` : id;
};

const FAILURE_INTRO = {
  gate_failed: 'The quick gate failed on your branch after your last session.',
  review: 'The reviewer requested changes. Address every finding below.',
  conflict: 'Your branch conflicts with the base branch.',
  premerge_failed: 'The full gate failed on your branch after it was merged with the latest base branch.',
  no_changes: 'The last session ended without any committed change on the branch.',
  partial: 'The previous session stopped before the task was complete. What it left is below; its handoff follows.',
  interrupted: 'The previous session was interrupted before it finished. Check `git status` and `git log` first, then continue.',
  answered: 'A person answered the question that was blocking this task.',
};

function feedbackBlock(H, task) {
  const f = task.lastFailure;
  if (!f) return '';
  const base = H.cfg.project.baseBranch;
  const extra =
    f.kind === 'conflict'
      ? `\nRun \`git merge ${base}\` in your worktree, resolve the conflicts so that both changes keep working, run the gate, and commit the merge. Conflicting files:`
      : '';
  return `## What happened last time\n${FAILURE_INTRO[f.kind] || f.kind}${extra}\n${fence(f.detail)}`;
}

function handoffBlock(task) {
  const h = task.handoff;
  if (!h) return '';
  const parts = [];
  if (h.done?.length) parts.push(`Done so far:\n${list(h.done)}`);
  if (h.remaining?.length) parts.push(`Remaining:\n${list(h.remaining)}`);
  if (h.gotchas?.length) parts.push(`Gotchas:\n${list(h.gotchas)}`);
  if (h.next_step) parts.push(`Suggested next step: ${h.next_step}`);
  return parts.length ? `## Handoff from the previous session\n${parts.join('\n\n')}` : '';
}

export function builderPrompt(H, task, { resume }) {
  const { state, cfg } = H;
  const max = cfg.limits.maxAttemptsPerTask;
  const gateCmd = `node "$HARNESS_BIN" gate --set quick${task.area ? ` --area ${task.area}` : ''}`;
  if (resume) {
    return [
      `# Follow-up on ${task.id} (attempt ${task.attempt} of ${max})`,
      feedbackBlock(H, task),
      `Fix this on the same branch, run \`${gateCmd}\`, commit, and finish with the result object.`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  const deps = (task.dependsOn || []).map((d) => state.tasks[d]).filter((d) => d?.status === 'merged');
  const env = Object.entries(worktreeEnv(H, task))
    .map(([k, v]) => `${k}=${v}`)
    .join('  ');
  const lessons = state.lessons.filter((l) => !l.distilled).slice(-8);
  const answered = state.inbox.filter((q) => q.status === 'answered').slice(-10);
  const cleanerExtra =
    task.role === 'cleaner'
      ? `## Lessons to fold into CLAUDE.md\n${list(
          state.lessons.filter((l) => !l.distilled).map((l) => `${l.text} (from ${l.from})`),
          '- (none reported since the last sweep)',
        )}`
      : '';
  return [
    `# Task ${task.id}: ${task.title}`,
    `Attempt ${task.attempt} of ${max} · kind: ${task.kind} · milestone: ${task.milestone} · area: ${task.area}`,
    `## What to deliver\n${task.description}`,
    task.doneWhen?.length ? `## Done when\n${list(task.doneWhen)}` : '',
    task.acceptance?.length
      ? `## Acceptance criteria this task contributes to\n${list(task.acceptance.map((a) => acLine(state, a)))}\nEach one needs an e2e test whose title contains its id.`
      : '',
    task.touches?.length ? `## Files you are expected to touch\n${list(task.touches)}\nOther tasks run in parallel on other paths. Stay inside yours unless the task cannot be done otherwise.` : '',
    deps.length ? `## Dependencies already merged\n${list(deps.map((d) => `${d.id} ${d.title}${d.summary ? ` — ${d.summary}` : ''}`))}` : '',
    task.guidance ? `## Guidance from the planner\n${task.guidance}` : '',
    feedbackBlock(H, task),
    handoffBlock(task),
    cleanerExtra,
    task.role !== 'cleaner' && lessons.length ? `## Recent lessons from other tasks\n${list(lessons.map((l) => l.text))}` : '',
    answered.length ? `## Decisions from the person\n${list(answered.map((q) => `${q.question} → ${q.answer}`))}` : '',
    [
      '## Your workspace',
      `- Worktree: ${task.worktree} on branch ${task.branch} (branched from ${cfg.project.baseBranch}). Stay on this branch.`,
      env ? `- Environment already set for you: ${env}` : '',
      `- Quick gate: \`${gateCmd}\`. It must pass before you finish.`,
    ]
      .filter(Boolean)
      .join('\n'),
    'Commit your work on this branch, then finish with the result object.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function reviewerPrompt(H, task, signals) {
  const { state, cfg } = H;
  const base = cfg.project.baseBranch;
  const flags = [];
  if (signals.weakened.length) flags.push(`Added lines that skip, ignore or silence checks:\n${fence(signals.weakened.join('\n'))}`);
  if (signals.deletedTests.length) flags.push(`Deleted test files:\n${list(signals.deletedTests)}`);
  if (signals.checkConfig.length) flags.push(`Build, lint or test configuration changed:\n${list(signals.checkConfig)}`);
  return [
    `# Review ${task.id}: ${task.title}`,
    `Branch ${task.branch} against ${base}. Read the change with \`git diff ${base}...HEAD\`. Do not modify anything.`,
    `## What the task asked for\n${task.description}`,
    task.doneWhen?.length ? `## Done when\n${list(task.doneWhen)}` : '',
    task.acceptance?.length ? `## Acceptance criteria it contributes to\n${list(task.acceptance.map((a) => acLine(state, a)))}` : '',
    `## Change summary\n${fence(signals.stat || '(empty diff)')}`,
    flags.length ? `## Flagged by the orchestrator — check each one\n${flags.join('\n\n')}` : '',
    task.summary ? `## Builder's summary\n${task.summary}` : '',
    'The quick gate already passes on this commit. Judge correctness against the task, test honesty, and fit with docs/ARCHITECTURE.md.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

const taskRow = (t) =>
  `| ${t.id} | ${t.status} | ${t.milestone} | ${t.area} | ${t.title} | ${(t.dependsOn || []).join(' ') || '-'} | ${(t.acceptance || []).join(' ') || '-'} |`;

export function plannerPrompt(H, { mode, reason }) {
  const { state, cfg } = H;
  const tasks = tasksOf(state);
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const answered = state.inbox.filter((q) => q.status === 'answered');
  const head = mode === 'initial' ? '# Plan request: initial plan' : `# Plan request: replan\nReason: ${reason || 'unspecified'}`;
  return [
    head,
    `PRD: ${cfg.project.prd}. Layout and command contract: docs/CONTRACTS.md. Up to ${cfg.limits.concurrency} tasks build in parallel, so prefer tasks with disjoint \`touches\`.`,
    `## Acceptance criteria\n${list(Object.keys(state.acs).map((id) => acLine(state, id)))}`,
    tasks.length
      ? `## Current tasks\n| id | status | milestone | area | title | depends on | acceptance |\n|---|---|---|---|---|---|---|\n${tasks.map(taskRow).join('\n')}`
      : '',
    blocked.length
      ? `## Blocked tasks — decide for each: retry with new guidance, split into smaller tasks (cancel + new), or cancel\n${blocked
          .map((t) => `### ${t.id} ${t.title}\nBlocked: ${t.blocked?.reason} — ${t.blocked?.detail || ''}\nLast failure (${t.lastFailure?.kind || 'n/a'}):\n${fence(String(t.lastFailure?.detail || '').slice(-2500))}`)
          .join('\n\n')}`
      : '',
    blockingIssues(state).length
      ? `## Open blocking issues\n${list(blockingIssues(state).map((i) => `${i.id} [${i.severity}, ${i.status}, seen ${i.recurrence + 1}x] ${i.title}`))}`
      : '',
    answered.length ? `## Answers from the person\n${list(answered.map((q) => `${q.question} → ${q.answer}`))}` : '',
    state.lessons.length ? `## Lessons so far\n${list(state.lessons.slice(-15).map((l) => l.text))}` : '',
    mode === 'initial'
      ? 'Write docs/ARCHITECTURE.md (and decision files) first, then return the plan object. Give every new task a unique `key`.'
      : 'Return only what changes: new tasks (unique `key` each; `depends_on` may name existing ids), `cancel`, and `retry`. Leave healthy tasks alone.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const planRepairPrompt = (errors) =>
  `The plan was rejected by validation:\n${list(errors)}\n\nReturn the complete corrected plan object (not a patch).`;

export function triagerPrompt(H, issues) {
  const { state } = H;
  return [
    '# Triage request',
    state.verify.stagingUrl ? `Staging: ${state.verify.stagingUrl}` : '',
    `Verification logs: .harness/runtime/logs/ (files starting with verify-).`,
    `## Issues that need a fix task\n${issues
      .map((i) => {
        const past = i.pastFixes.map((id) => state.tasks[id]).filter(Boolean);
        return [
          `### ${i.id} [${i.severity}] ${i.title}`,
          i.acceptance.length ? `Criteria: ${i.acceptance.join(', ')}` : '',
          past.length
            ? `Earlier fixes that did not resolve it (do something different):\n${list(past.map((t) => `${t.id} ${t.title} [${t.status}]${t.summary ? ` — ${t.summary}` : ''}`))}`
            : '',
          `Evidence:\n${fence(String(i.evidence || '').slice(-3000))}`,
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n')}`,
    'Find the root cause in the code and logs. Return one fix task per root cause; a task may fix several issues. Every task must list the issue ids it fixes.',
  ]
    .filter(Boolean)
    .join('\n\n');
}
