// The task graph: pure functions over state. No I/O, no git, no processes.
//
// Task life cycle (every arrow is taken by the orchestrator, never by an agent):
//
//   todo ──► building ──► built ──► gating ──► gated ──► reviewing ──► approved ──► premerge ──► merged
//              ▲                      │                      │             │            │
//              └──────── rework ◄─────┴── gate failed ───────┴─ changes ───┴─ conflict ─┘
//                           │
//                           └─ attempts exhausted ──► blocked ──► (replan: retry | split | cancel)
import { nextIssueId, nextQuestionId, nextTaskId } from './store.mjs';
import { globsOverlap, now } from './util.mjs';

export const ACTIVE_STATUSES = ['todo', 'rework', 'building', 'built', 'gating', 'gated', 'reviewing', 'approved', 'premerge'];
export const IN_FLIGHT = ['rework', 'building', 'built', 'gating', 'gated', 'reviewing', 'approved', 'premerge'];
const SETTLED = ['merged', 'cancelled'];
const AREAS = ['web', 'server', 'db', 'e2e', 'infra', 'docs'];

export const tasksOf = (state) => Object.values(state.tasks);
const milestoneIndex = (state, id) => {
  const i = state.milestones.findIndex((m) => m.id === id);
  return i === -1 ? 999 : i;
};

// ---- PRD ----------------------------------------------------------------------

/** Acceptance criteria are list items, headings or table rows that start with an AC id. */
export function parsePrd(text) {
  const acs = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(?:[-*+]|\d+\.|#{1,6}|\|)\s*(?:\[[ xX]\]\s*)?\**\s*(AC-\d+)\b\**\s*(.*)$/);
    if (!m || acs[m[1]]) continue;
    let rest = m[2];
    let priority = 'must';
    const p = rest.match(/^[\s:|]*[([]\s*(must|should|could)\s*[)\]]/i);
    if (p) {
      priority = p[1].toLowerCase();
      rest = rest.slice(p[0].length);
    }
    const text2 = rest
      .replace(/^[\s:|—–-]+/, '')
      .replace(/\s*\|\s*$/, '')
      .trim();
    acs[m[1]] = { text: text2, priority };
  }
  return acs;
}

export function syncAcs(state, parsed) {
  for (const [id, ac] of Object.entries(parsed)) {
    state.acs[id] = { status: 'unknown', ...(state.acs[id] || {}), text: ac.text, priority: ac.priority };
  }
  for (const id of Object.keys(state.acs)) if (!parsed[id]) delete state.acs[id];
}

// ---- plan validation and application -----------------------------------------

/** Returns a list of problems the planner must repair. Empty means the plan is usable. */
export function validatePlan(state, plan) {
  const errors = [];
  const newTasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const cancel = new Set(plan?.cancel || []);
  const retry = plan?.retry || [];
  const existing = state.tasks;

  if (!tasksOf(state).length && !newTasks.length) errors.push('The plan contains no tasks.');

  const keys = new Set();
  for (const [i, t] of newTasks.entries()) {
    const label = t.key || `tasks[${i}]`;
    if (!t.key) errors.push(`tasks[${i}] is missing "key".`);
    else if (keys.has(t.key) || existing[t.key]) errors.push(`Task key "${t.key}" is not unique.`);
    keys.add(t.key);
    if (!t.title) errors.push(`${label}: missing title.`);
    if (!t.description) errors.push(`${label}: missing description.`);
    if (!AREAS.includes(t.area)) errors.push(`${label}: area must be one of ${AREAS.join(', ')}.`);
    for (const ac of t.acceptance || []) if (!state.acs[ac]) errors.push(`${label}: unknown acceptance criterion ${ac}.`);
  }
  for (const id of cancel) {
    if (!existing[id]) errors.push(`cancel: ${id} does not exist.`);
    else if (existing[id].status === 'merged') errors.push(`cancel: ${id} is already merged.`);
  }
  for (const r of retry) {
    if (!existing[r.id]) errors.push(`retry: ${r.id} does not exist.`);
    else if (existing[r.id].status !== 'blocked') errors.push(`retry: ${r.id} is not blocked.`);
  }

  // dependency references and cycles over the combined graph
  const deps = new Map();
  for (const t of tasksOf(state)) if (!cancel.has(t.id)) deps.set(t.id, t.dependsOn || []);
  for (const t of newTasks) {
    if (!t.key) continue;
    for (const d of t.depends_on || []) {
      if (!keys.has(d) && !existing[d]) errors.push(`${t.key}: depends_on "${d}" matches no task.`);
      if (cancel.has(d)) errors.push(`${t.key}: depends_on "${d}" which this plan cancels.`);
    }
    if (!deps.has(t.key)) deps.set(t.key, t.depends_on || []); // a duplicate key must not hide the first one's edges
  }
  const seen = new Map();
  const visit = (n, trail) => {
    if (seen.get(n) === 2) return;
    if (seen.get(n) === 1) {
      errors.push(`Dependency cycle: ${[...trail, n].join(' -> ')}.`);
      return;
    }
    seen.set(n, 1);
    for (const d of deps.get(n) || []) visit(d, [...trail, n]);
    seen.set(n, 2);
  };
  for (const n of deps.keys()) visit(n, []);

  // every unmet "must" criterion needs at least one live task
  const covered = new Set();
  for (const t of tasksOf(state)) {
    const willLive = !cancel.has(t.id) && t.status !== 'cancelled' && (t.status !== 'blocked' || retry.some((r) => r.id === t.id));
    if (willLive) for (const ac of t.acceptance || []) covered.add(ac);
  }
  for (const t of newTasks) for (const ac of t.acceptance || []) covered.add(ac);
  for (const [id, ac] of Object.entries(state.acs)) {
    if (ac.priority === 'must' && ac.status !== 'pass' && !covered.has(id)) {
      errors.push(`${id} (must) is not covered by any task. Add a task whose "acceptance" lists it.`);
    }
  }
  return errors;
}

export function newTask(state, spec) {
  const id = nextTaskId(state);
  const task = {
    id,
    title: spec.title,
    description: spec.description || '',
    milestone: spec.milestone || 'M0',
    area: spec.area || 'docs',
    kind: spec.kind || 'feature',
    role: spec.role || 'builder',
    priority: spec.priority === 'later' ? 'later' : 'mvp',
    size: spec.size || 'M',
    acceptance: spec.acceptance || [],
    doneWhen: spec.done_when || spec.doneWhen || [],
    dependsOn: spec.dependsOn || [],
    touches: spec.touches || [],
    fixes: spec.fixes || [],
    status: 'todo',
    attempt: 0,
    replanned: 0,
    reviewFailures: 0,
    thread: null,
    branch: null,
    worktree: null,
    slot: null,
    gatedSha: null,
    premergeOkSha: null,
    lastFailure: null,
    handoff: null,
    summary: null,
    review: null,
    blocked: null,
    guidance: spec.guidance || null,
    history: [{ at: now(), event: 'created' }],
    createdAt: now(),
    mergedAt: null,
  };
  state.tasks[id] = task;
  return task;
}

/** Apply a validated plan. Returns a summary of what changed. */
export function applyPlan(state, plan) {
  for (const m of plan.milestones || []) {
    const cur = state.milestones.find((x) => x.id === m.id);
    if (cur) Object.assign(cur, m);
    else state.milestones.push({ id: m.id, title: m.title || m.id, goal: m.goal || '' });
  }
  const keyToId = {};
  const created = [];
  for (const spec of plan.tasks || []) {
    const t = newTask(state, spec);
    keyToId[spec.key] = t.id;
    created.push([t, spec]);
    if (!state.milestones.some((m) => m.id === t.milestone)) state.milestones.push({ id: t.milestone, title: t.milestone, goal: '' });
  }
  for (const [t, spec] of created) t.dependsOn = (spec.depends_on || []).map((d) => keyToId[d] || d);

  const cancelled = [];
  for (const id of plan.cancel || []) {
    const t = state.tasks[id];
    if (!t || t.status === 'merged') continue;
    t.status = 'cancelled';
    t.history.push({ at: now(), event: 'cancelled', by: 'planner' });
    state.mergeQueue = state.mergeQueue.filter((x) => x !== id);
    cancelled.push(id);
  }
  const retried = [];
  for (const r of plan.retry || []) {
    const t = state.tasks[r.id];
    if (!t || t.status !== 'blocked') continue;
    t.status = t.worktree ? 'rework' : 'todo';
    t.attempt = 0;
    t.replanned += 1;
    t.blocked = null;
    t.thread = null; // new approach, new context
    t.guidance = r.guidance || null;
    t.history.push({ at: now(), event: 'retry', by: 'planner' });
    retried.push(r.id);
  }
  return { created: created.map(([t]) => t.id), cancelled, retried };
}

// ---- scheduling ---------------------------------------------------------------

const depsSettled = (state, t) => (t.dependsOn || []).every((d) => !state.tasks[d] || SETTLED.includes(state.tasks[d].status));

export function readyTasks(state) {
  return tasksOf(state)
    .filter((t) => (t.status === 'todo' || t.status === 'rework') && t.priority === 'mvp' && depsSettled(state, t))
    .sort(
      (a, b) =>
        (a.status === 'rework' ? 0 : 1) - (b.status === 'rework' ? 0 : 1) || // finish work in progress first
        milestoneIndex(state, a.milestone) - milestoneIndex(state, b.milestone) ||
        a.id.localeCompare(b.id),
    );
}

/** What a task is expected to edit. Used to keep overlapping tasks out of each other's way. */
export const claims = (t) => (t.touches?.length ? t.touches : [`${t.area}/**`]);

/** Choose which ready tasks to start, given free slots and the tasks already holding claims. */
export function pickDispatch(state, slots) {
  const picked = [];
  const holders = tasksOf(state).filter((t) => IN_FLIGHT.includes(t.status));
  for (const t of readyTasks(state)) {
    if (picked.length >= slots) break;
    // Two tasks that are both waiting for rework never block each other, or neither could move.
    const others = [...holders.filter((h) => h.id !== t.id && !(t.status === 'rework' && h.status === 'rework')), ...picked];
    if (others.some((o) => globsOverlap(claims(t), claims(o)))) continue;
    picked.push(t);
  }
  return picked;
}

/** Tasks that can never start because something they depend on is blocked. */
export function starvedTasks(state) {
  return tasksOf(state).filter(
    (t) => t.status === 'todo' && t.priority === 'mvp' && (t.dependsOn || []).some((d) => state.tasks[d]?.status === 'blocked'),
  );
}

export const isDrained = (state) => !tasksOf(state).some((t) => t.priority === 'mvp' && ACTIVE_STATUSES.includes(t.status));

export function completedMilestones(state) {
  return state.milestones
    .filter((m) => {
      const ts = tasksOf(state).filter((t) => t.milestone === m.id && t.priority === 'mvp');
      return ts.length && ts.every((t) => SETTLED.includes(t.status)) && ts.some((t) => t.status === 'merged');
    })
    .map((m) => m.id);
}

// ---- acceptance criteria and convergence -------------------------------------

const coveringTasks = (state, ac) => tasksOf(state).filter((t) => t.status !== 'cancelled' && (t.acceptance || []).includes(ac));

/** Criteria that should pass right now: every task that contributes to them has merged. */
export function expectedAcs(state) {
  return Object.keys(state.acs).filter((ac) => {
    const cover = coveringTasks(state, ac);
    return cover.length > 0 && cover.every((t) => t.status === 'merged');
  });
}

/** "must" criteria that no live task covers (for example, added to the PRD after planning). */
export const orphanedMust = (state) =>
  Object.entries(state.acs)
    .filter(([id, ac]) => ac.priority === 'must' && ac.status !== 'pass' && coveringTasks(state, id).length === 0)
    .map(([id]) => id);

export const blockingIssues = (state) =>
  Object.values(state.issues).filter((i) => (i.status === 'open' || i.status === 'stuck') && (i.severity === 'P0' || i.severity === 'P1'));

export function isDone(state) {
  const must = Object.values(state.acs).filter((a) => a.priority === 'must');
  return must.length > 0 && must.every((a) => a.status === 'pass') && blockingIssues(state).length === 0 && isDrained(state);
}

// ---- issues -------------------------------------------------------------------

/**
 * Record a failure seen during verification. One issue per fingerprint; if a fix already
 * merged and the failure is still there, the recurrence counter goes up and the issue is
 * handed back to triage. Enough recurrences and the issue is declared stuck.
 */
export function upsertFailure(state, fp, { title, severity, evidence, acceptance = [] }, maxRecurrence) {
  let issue = Object.values(state.issues).find((i) => i.fingerprint === fp && i.status !== 'closed');
  if (!issue) {
    const id = nextIssueId(state);
    issue = {
      id,
      fingerprint: fp,
      title,
      severity,
      status: 'open',
      source: 'verify',
      evidence,
      acceptance,
      recurrence: 0,
      triageAttempts: 0,
      fixTasks: [],
      pastFixes: [],
      createdAt: now(),
      closedAt: null,
    };
    state.issues[id] = issue;
    return issue;
  }
  issue.evidence = evidence;
  const fixes = issue.fixTasks.map((id) => state.tasks[id]).filter(Boolean);
  const fixLanded = fixes.length > 0 && fixes.every((t) => SETTLED.includes(t.status) || t.status === 'blocked');
  if (fixLanded) {
    issue.recurrence += 1;
    issue.pastFixes.push(...issue.fixTasks);
    issue.fixTasks = [];
    if (issue.recurrence >= maxRecurrence) issue.status = 'stuck';
  }
  return issue;
}

/** Close verification issues whose fingerprint no longer fails. */
export function closeResolved(state, failingFingerprints) {
  const closed = [];
  for (const i of Object.values(state.issues)) {
    if (i.source === 'verify' && i.status !== 'closed' && !failingFingerprints.has(i.fingerprint)) {
      i.status = 'closed';
      i.closedAt = now();
      closed.push(i.id);
    }
  }
  return closed;
}

/** Issues that still need a fix task. */
export const untriaged = (state) =>
  Object.values(state.issues).filter((i) => i.status === 'open' && (i.severity === 'P0' || i.severity === 'P1') && i.fixTasks.length === 0);

/**
 * Issues reported by agents while working on something else. Serious ones (P0, P1) get a fix
 * task, but only `budget` of them over the whole run; the rest wait in the backlog. Without a
 * ceiling, sessions that keep finding things would keep the loop from ever finishing.
 */
export function addDiscovered(state, found, from, budget = Infinity) {
  const out = [];
  let accepted = Object.values(state.issues).filter((i) => i.source !== 'verify' && i.status !== 'backlog').length;
  for (const f of found || []) {
    if (!f?.title) continue;
    const fp = `found:${f.title.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    if (Object.values(state.issues).some((i) => i.fingerprint === fp)) continue;
    const id = nextIssueId(state);
    const sev = ['P0', 'P1', 'P2', 'P3'].includes(f.severity) ? f.severity : 'P2';
    state.issues[id] = {
      id,
      fingerprint: fp,
      title: f.title,
      severity: sev,
      // Agent-reported problems go to the backlog unless they are serious; only failing
      // "must" criteria and failing verify steps are allowed to hold up the launch by default.
      status: (sev === 'P0' || sev === 'P1') && accepted++ < budget ? 'open' : 'backlog',
      source: from,
      evidence: f.detail || '',
      acceptance: [],
      recurrence: 0,
      triageAttempts: 0,
      fixTasks: [],
      pastFixes: [],
      createdAt: now(),
      closedAt: null,
    };
    out.push(id);
  }
  return out;
}

// ---- inbox --------------------------------------------------------------------

export function addQuestions(state, questions, from) {
  const out = [];
  for (const q of questions || []) {
    if (!q?.question) continue;
    const id = nextQuestionId(state);
    state.inbox.push({
      id,
      question: q.question,
      default: q.default || null,
      blocking: !!q.blocking,
      from,
      status: 'open',
      answer: null,
      createdAt: now(),
    });
    out.push(id);
  }
  return out;
}

export function addLessons(state, lessons, from) {
  for (const text of lessons || []) {
    if (typeof text !== 'string' || !text.trim()) continue;
    if (state.lessons.some((l) => l.text === text.trim())) continue;
    state.lessons.push({ text: text.trim(), from, at: now(), distilled: false });
  }
}

/** A compact fingerprint of what is failing, used to detect a loop that is not converging. */
export const failureFingerprint = (fps) => [...fps].sort().join('|');
