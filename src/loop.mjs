// The loop. One orchestrator process owns the state and walks the task graph until the MVP is
// verified on staging or there is nothing left it can do without a person.
//
//   every tick:  plan? → advance tasks (gate, review) → merge queue → verify → triage → cleaner → dispatch builders
//   then:        wait for any child (agent session, gate, verify) to finish, apply its result, tick again
//
// Two lanes limit what runs at once:
//   task lane  up to limits.concurrency children: builder sessions, quick gates, reviews (each in a task worktree)
//   main lane  one child at a time: planner, pre-merge gate, verification, triage (anything tied to the base branch)
import fs from 'node:fs';
import path from 'node:path';
import { HARNESS_BIN, SCHEMAS, detectClaude, startAgent } from './agents.mjs';
import { fullAddsNothing, gateFailureText } from './gates.mjs';
import {
  ACTIVE_STATUSES,
  addDiscovered,
  addLessons,
  addQuestions,
  applyPlan,
  blockingIssues,
  closeResolved,
  completedMilestones,
  expectedAcs,
  failureFingerprint,
  isDone,
  isDrained,
  newTask,
  orphanedMust,
  parsePrd,
  pickDispatch,
  starvedTasks,
  syncAcs,
  tasksOf,
  untriaged,
  upsertFailure,
  validatePlan,
} from './graph.mjs';
import { builderPrompt, planRepairPrompt, plannerPrompt, reviewerPrompt, triagerPrompt } from './prompts.mjs';
import { stopText, writeViews } from './render.mjs';
import { acquireLock, clearStop, loadRuns, nextRunId, openHarness, saveRuns, stopRequested } from './store.mjs';
import { git, killTree, log, now, pidAlive, run, sleep, tail, uuid } from './util.mjs';
import {
  autosave,
  baseSha,
  commitDocs,
  commitsAhead,
  diffSignals,
  ensureWorktree,
  headSha,
  mergeToBase,
  removeWorktree,
  resetTo,
  revertProtected,
  stashStrays,
  syncBase,
  worktreeEnv,
} from './worktrees.mjs';

/** Checks that must hold before the loop may touch the repository. */
export function preflight(H, caps) {
  const { root, cfg, state } = H;
  const errors = [];
  const warnings = [];
  const top = git(['rev-parse', '--show-toplevel'], root, { allowFail: true });
  if (top.code !== 0) errors.push('Not a git repository. Run `git init -b main` and make a first commit.');
  else {
    if (fs.realpathSync(top.out) !== fs.realpathSync(root)) errors.push(`The harness must run from the repository root (${top.out}).`);
    if (git(['rev-parse', '--verify', '--quiet', 'HEAD'], root, { allowFail: true }).code !== 0) {
      errors.push('The repository has no commits. Commit the scaffold first: `git add -A && git commit -m "chore: bootstrap"`.');
    } else {
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root).out;
      if (branch !== cfg.project.baseBranch) errors.push(`The main checkout is on "${branch}" but project.baseBranch is "${cfg.project.baseBranch}".`);
      const dirty = git(['status', '--porcelain', '--untracked-files=no'], root).out;
      if (dirty) errors.push(`The main checkout has uncommitted changes to tracked files. Commit or stash them:\n${dirty}`);
      // Task worktrees are fresh checkouts of the base branch: what is not committed does not exist there.
      const needed = ['CLAUDE.md', '.harness/config.json', cfg.project.prd, '.claude/settings.json', '.claude/hooks/guard.mjs', '.claude/hooks/stop-gate.mjs'];
      for (const rc of Object.values(cfg.roles)) if (rc.agent) needed.push(`.claude/agents/${rc.agent}.md`);
      const untracked = [...new Set(needed)].filter((p) => fs.existsSync(path.join(root, p)) && git(['ls-files', '--error-unmatch', p], root, { allowFail: true }).code !== 0);
      if (untracked.length) {
        errors.push(`Not committed: ${untracked.join(', ')}. Task worktrees are created from the ${cfg.project.baseBranch} branch, so sessions there would run without these files. Commit them.`);
      }
    }
    const ignored = ['.harness/state.json', 'STATE.md', 'HANDOFF.md'].filter((p) => git(['check-ignore', '-q', p], root, { allowFail: true }).code !== 0);
    if (ignored.length) warnings.push(`Not gitignored: ${ignored.join(', ')}. Generated state should stay out of git; run harness init again to add the entries.`);
  }
  const prdFile = path.join(root, cfg.project.prd);
  if (!fs.existsSync(prdFile)) errors.push(`Missing ${cfg.project.prd}. It must list acceptance criteria such as "- **AC-001** (must) …".`);
  else {
    const acs = parsePrd(fs.readFileSync(prdFile, 'utf8'));
    if (!Object.values(acs).some((a) => a.priority === 'must')) errors.push(`${cfg.project.prd} has no "must" acceptance criteria (lines starting with "- **AC-001** (must) …").`);
  }
  if (!caps.found) errors.push(`Cannot run "${cfg.claude.bin} --version". Install Claude Code or set claude.bin in .harness/config.json.`);
  for (const [role, rc] of Object.entries(cfg.roles)) {
    if (rc.agent && !fs.existsSync(path.join(root, '.claude', 'agents', `${rc.agent}.md`))) warnings.push(`No .claude/agents/${rc.agent}.md for role "${role}".`);
  }
  if (!fs.existsSync(path.join(root, '.claude', 'settings.json'))) warnings.push('No .claude/settings.json: sessions would run without the path guard and the inner gate loop. Run `harness init`.');
  if (!cfg.gates.length) warnings.push('No gates are configured: nothing checks the work before it merges.');
  if (!cfg.verify.steps.length) warnings.push('No verify steps are configured: the loop has no way to prove the MVP works on staging.');
  if (caps.found && !caps.permissionPrompts) warnings.push(`Claude Code ${caps.version || ''} does not support --permission-prompts none (needs 2.1.259+). Unanswered permission requests are still denied in -p mode.`);
  if (state.plan.runs === 0 && Object.keys(state.tasks).length) warnings.push('State has tasks but no recorded plan run.');
  return { errors, warnings };
}

class Loop {
  constructor(H, opts) {
    this.H = H;
    this.cfg = H.cfg;
    this.state = H.state;
    this.opts = opts;
    this.caps = opts.caps;
    this.active = new Map();
    this.stopping = null;
    this.aborting = false;
    this.backoffMs = 0;
    this.t0 = Date.now();
    this.priorMs = this.state.counters.activeMs || 0;
    this.runsAtStart = this.state.counters.runs;
  }

  // ---- small helpers ----------------------------------------------------------

  get limits() {
    return this.cfg.limits;
  }
  lane(name) {
    return [...this.active.values()].filter((r) => r.lane === name);
  }
  freeSlots() {
    return this.limits.concurrency - this.lane('task').length;
  }
  mainBusy() {
    return this.lane('main').length > 0;
  }
  stop(reason, detail = '') {
    if (!this.stopping) this.stopping = { reason, detail };
  }
  note(task, event, extra = {}) {
    task.history.push({ at: now(), event, ...extra });
    if (task.history.length > 60) task.history.splice(0, task.history.length - 60);
    this.H.event(event, { task: task.id, ...extra });
    log(`${task.id} ${event}${extra.reason ? ` (${extra.reason})` : ''}`);
  }
  persist() {
    this.state.counters.activeMs = this.priorMs + (Date.now() - this.t0);
    this.H.save();
    try {
      writeViews(this.H);
    } catch (err) {
      log(`warning: could not write STATE.md/HANDOFF.md: ${err.message}`);
    }
  }
  track(runRec, donePromise) {
    runRec.promise = donePromise.then(
      (result) => ({ run: runRec, result }),
      (err) => ({ run: runRec, result: { infra: true, crashed: true, text: String(err?.stack || err), stdout: '', stderr: String(err) } }),
    );
    this.active.set(runRec.id, runRec);
    saveRuns(this.H, [...this.active.values()]);
  }

  // ---- starting children ------------------------------------------------------

  startAgentRun({ role, task, prompt, cwd, env, lane, kind, sessionId, resume = false, schema, extra = {} }) {
    const { H, state } = this;
    const id = nextRunId(state);
    state.counters.runs += 1;
    const proc = startAgent(H, this.caps, {
      role,
      task,
      prompt,
      cwd,
      env,
      sessionId,
      resume,
      schema,
      runId: id,
      name: `${task ? task.id : 'project'} ${role} ${id}`,
      spentUsd: resume ? state.sessions[sessionId] || 0 : 0,
    });
    const rec = { id, kind, role, taskId: task?.id || null, sessionId, resume, pid: proc.pid, lane, startedAt: now(), ...extra };
    this.track(rec, proc.done);
    H.event('run_started', { run: id, kind, role, task: task?.id, session: sessionId, resume });
    log(`${id} ${role}${task ? ` ${task.id}` : ''} ${resume ? 'resumed' : 'started'} (session ${sessionId.slice(0, 8)})`);
    return rec;
  }

  startGateRun({ task, set, lane, kind }) {
    const { H, state } = this;
    const id = nextRunId(state);
    const args = [HARNESS_BIN, 'gate', '--json', '--set', set, '--root', H.root, '--cwd', task.worktree, '--log-dir', path.join(H.runtime, 'logs', `${id}-gate`)];
    if (set === 'quick' && task.area) args.push('--area', task.area);
    const proc = run(process.execPath, args, {
      cwd: task.worktree,
      env: worktreeEnv(H, task),
      timeoutMs: this.limits.gateTimeoutMin * 60000 * Math.max(1, this.cfg.gates.length),
    });
    const rec = { id, kind, role: 'gate', taskId: task.id, pid: proc.pid, lane, startedAt: now() };
    this.track(rec, proc.done);
    H.event('run_started', { run: id, kind, task: task.id, set });
    log(`${id} ${set} gate ${task.id} started`);
    return rec;
  }

  // ---- tick -------------------------------------------------------------------

  tick() {
    this.checkBudgets();
    if (this.stopping) return false;
    let progressed = false;
    for (const step of ['maybePlan', 'advanceTasks', 'mergeLane', 'verifyLane', 'triageLane', 'scheduleCleaner', 'dispatchBuilders']) {
      if (this.stopping) break;
      progressed = this[step]() || progressed;
    }
    return progressed;
  }

  checkBudgets() {
    const { state, limits } = this;
    const hours = (this.priorMs + (Date.now() - this.t0)) / 3600000;
    if (stopRequested(this.H)) this.stop('user_stop');
    else if (state.counters.infraFailures >= limits.infraFailuresBeforeStop) this.stop('agent_runtime_error', this.lastInfraText || '');
    else if (state.counters.runs >= limits.maxRuns) this.stop('budget_runs');
    else if (state.counters.costUsd >= limits.maxCostUsd) this.stop('budget_cost');
    else if (hours >= limits.maxHours) this.stop('budget_time');
    else if (this.opts.maxRuns && state.counters.runs - this.runsAtStart >= this.opts.maxRuns) this.stop('user_stop', `Stopped after ${this.opts.maxRuns} session(s) as requested with --max-runs.`);
  }

  maybePlan() {
    const { state } = this;
    const plan = state.plan;
    if (this.mainBusy()) return false;
    const first = plan.runs === 0;
    if (!first && !plan.needsReplan) return false;
    if (!first) plan.replans += 1;
    if (first) state.phase = 'planning';
    this.startAgentRun({
      role: 'planner',
      prompt: plannerPrompt(this.H, { mode: first ? 'initial' : 'replan', reason: plan.reason }),
      cwd: this.H.root,
      lane: 'main',
      kind: 'plan',
      sessionId: uuid(),
      schema: SCHEMAS.plan,
    });
    return true;
  }

  advanceTasks() {
    let progressed = false;
    for (const t of tasksOf(this.state)) {
      if (this.freeSlots() <= 0) break;
      if (t.status === 'built') {
        t.status = 'gating';
        this.startGateRun({ task: t, set: 'quick', lane: 'task', kind: 'gate' });
        progressed = true;
      } else if (t.status === 'gated') {
        t.status = 'reviewing';
        this.startAgentRun({
          role: 'reviewer',
          task: t,
          prompt: reviewerPrompt(this.H, t, diffSignals(this.H, t)),
          cwd: t.worktree,
          env: worktreeEnv(this.H, t),
          lane: 'task',
          kind: 'review',
          sessionId: uuid(), // always a fresh pair of eyes
          schema: SCHEMAS.review,
        });
        progressed = true;
      }
    }
    return progressed;
  }

  /** Serialised landing: only the head of the queue may sync with the base branch and merge. */
  mergeLane() {
    const { state, H } = this;
    if (this.mainBusy()) return false;
    const id = state.mergeQueue[0];
    if (!id) return false;
    const t = state.tasks[id];
    if (!t || t.status !== 'approved') {
      state.mergeQueue.shift();
      return true;
    }
    const sync = syncBase(H, t);
    if (!sync.ok) {
      this.rework(t, 'conflict', sync.detail);
      return true;
    }
    const head = headSha(t.worktree);
    const proven = t.premergeOkSha === head || (fullAddsNothing(this.cfg) && t.gatedSha === head);
    if (proven) {
      this.land(t);
      return true;
    }
    t.status = 'premerge';
    this.startGateRun({ task: t, set: 'full', lane: 'main', kind: 'premerge' });
    return true;
  }

  land(t) {
    const { state, H } = this;
    let sha;
    try {
      sha = mergeToBase(H, t);
    } catch (err) {
      this.stop('main_checkout_error', err.message);
      return;
    }
    state.mergeQueue = state.mergeQueue.filter((x) => x !== t.id);
    t.status = 'merged';
    t.mergedAt = now();
    t.mergedSha = sha;
    removeWorktree(H, t);
    state.counters.merges += 1;
    state.counters.mergesSinceClean += 1;
    // An issue an agent reported is resolved when every fix task for it has landed.
    for (const i of Object.values(state.issues)) {
      if (i.source === 'verify' || i.status !== 'open' || !i.fixTasks.includes(t.id)) continue;
      if (i.fixTasks.every((id) => state.tasks[id]?.status === 'merged')) {
        i.status = 'closed';
        i.closedAt = now();
      }
    }
    if (t.role === 'cleaner') {
      for (const l of state.lessons) if (t.lessonsUpTo && l.at <= t.lessonsUpTo) l.distilled = true;
      state.counters.mergesSinceClean = 0;
    }
    this.note(t, 'merged', { sha: sha.slice(0, 7) });
  }

  verifyLane() {
    const { state, H, limits } = this;
    if (this.mainBusy() || state.mergeQueue.length || !state.counters.merges) return false;
    if (state.verify.cycles >= limits.maxVerifyCycles) return false;
    const sha = baseSha(H);
    if (sha === state.verify.lastSha) return false;
    const milestones = completedMilestones(state);
    const milestoneJustFinished = milestones.some((m) => !state.verify.milestonesDone.includes(m));
    if (!isDrained(state) && !milestoneJustFinished) return false;
    state.verify.pending = { sha, milestones };
    state.phase = 'verifying';
    const id = nextRunId(state);
    const proc = run(process.execPath, [HARNESS_BIN, 'verify', '--json', '--root', H.root, '--log-dir', path.join(H.runtime, 'logs')], {
      cwd: H.root,
      timeoutMs: limits.gateTimeoutMin * 60000 * Math.max(1, this.cfg.verify.steps.length),
    });
    this.track({ id, kind: 'verify', role: 'verify', taskId: null, pid: proc.pid, lane: 'main', startedAt: now() }, proc.done);
    H.event('run_started', { run: id, kind: 'verify', sha: sha.slice(0, 7) });
    log(`${id} verification started at ${sha.slice(0, 7)}`);
    return true;
  }

  triageLane() {
    const { state } = this;
    if (this.mainBusy() || !state.triage.pending) return false;
    const issues = untriaged(state);
    if (!issues.length) {
      state.triage.pending = false;
      return false;
    }
    this.startAgentRun({
      role: 'triager',
      prompt: triagerPrompt(this.H, issues),
      cwd: this.H.root,
      lane: 'main',
      kind: 'triage',
      sessionId: uuid(),
      schema: SCHEMAS.triage,
      extra: { issueIds: issues.map((i) => i.id) },
    });
    return true;
  }

  /** Entropy control: after enough merges, a cleaner task goes through the same pipeline as any other. */
  scheduleCleaner() {
    const { state, limits } = this;
    if (!limits.cleanEveryMerges || state.counters.mergesSinceClean < limits.cleanEveryMerges) return false;
    if (tasksOf(state).some((t) => t.role === 'cleaner' && ACTIVE_STATUSES.includes(t.status))) return false;
    state.seq.clean += 1;
    const t = newTask(state, {
      title: `Entropy sweep #${state.seq.clean}`,
      description:
        'Bring the documentation back in line with the code as merged, fold the reported lessons into CLAUDE.md, and report (do not fix) code-level debt.',
      kind: 'chore',
      role: 'cleaner',
      area: 'docs',
      milestone: 'UPKEEP',
      touches: ['CLAUDE.md', 'docs/**'],
    });
    state.counters.mergesSinceClean = 0;
    this.note(t, 'cleaner_scheduled');
    return true;
  }

  dispatchBuilders() {
    const { state } = this;
    if (state.plan.runs === 0 || this.lane('main').some((r) => r.kind === 'plan')) return false;
    if (this.cfg.humanGates.plan && !state.plan.approved) return false;
    const picks = pickDispatch(state, this.freeSlots());
    for (const t of picks) this.startBuilder(t);
    return picks.length > 0;
  }

  /**
   * Session policy. Feedback on the same piece of work goes back to the session that wrote it
   * (it still has the context), up to maxResumesPerSession times. After that the thread rotates
   * to a fresh session seeded with the handoff note, so context never rots.
   */
  startBuilder(t) {
    const { H, state } = this;
    try {
      ensureWorktree(H, t);
    } catch (err) {
      this.block(t, 'worktree_error', err.message);
      return;
    }
    t.prevStatus = t.status;
    t.attempt += 1;
    const th = t.thread;
    const resume = t.status === 'rework' && !!th?.sessionId && !th.dead && th.resumes < this.limits.maxResumesPerSession;
    if (resume) th.resumes += 1;
    else t.thread = { sessionId: uuid(), resumes: 0, turns: 0, dead: false, generation: (th?.generation || 0) + 1 };
    if (t.role === 'cleaner') t.lessonsUpTo = now(); // lessons listed in this brief are the ones it folds in
    const prompt = builderPrompt(H, t, { resume });
    t.status = 'building';
    if (state.phase !== 'verifying') state.phase = 'building';
    this.startAgentRun({
      role: t.role,
      task: t,
      prompt,
      cwd: t.worktree,
      env: worktreeEnv(H, t),
      lane: 'task',
      kind: 'build',
      sessionId: t.thread.sessionId,
      resume,
      schema: SCHEMAS.build,
    });
  }

  // ---- transitions ------------------------------------------------------------

  rework(t, kind, detail) {
    const { state } = this;
    t.lastFailure = { kind, detail: String(detail || '').slice(-8000), at: now() };
    state.mergeQueue = state.mergeQueue.filter((x) => x !== t.id);
    if (t.attempt >= this.limits.maxAttemptsPerTask) {
      this.block(t, 'exhausted', `${kind} after ${t.attempt} attempts`);
      return;
    }
    t.status = 'rework';
    this.note(t, 'rework', { reason: kind });
  }

  block(t, reason, detail) {
    const { state, limits } = this;
    t.status = 'blocked';
    t.blocked = { reason, detail: String(detail || '').slice(0, 2000), at: now() };
    state.mergeQueue = state.mergeQueue.filter((x) => x !== t.id);
    this.note(t, 'blocked', { reason });
    if (t.kind === 'fix') {
      // A fix that could not land counts as a failed fix: hand its issues back to triage.
      for (const i of Object.values(state.issues)) {
        if (!i.fixTasks.includes(t.id)) continue;
        i.fixTasks = i.fixTasks.filter((x) => x !== t.id);
        i.pastFixes.push(t.id);
        i.recurrence += 1;
        if (i.recurrence >= limits.maxIssueRecurrence) i.status = 'stuck';
        else state.triage.pending = true;
      }
    } else if (reason === 'exhausted' && t.role !== 'cleaner' && t.replanned < 1 && state.plan.replans < limits.maxReplans) {
      state.plan.needsReplan = true;
      state.plan.reason = `${t.id} "${t.title}" used all its attempts.`;
    }
  }

  approve(t) {
    t.status = 'approved';
    t.approvedOnce = true;
    if (!this.state.mergeQueue.includes(t.id)) this.state.mergeQueue.push(t.id);
    this.note(t, 'approved');
  }

  account(runRec, res) {
    const { state } = this;
    const sid = runRec.sessionId;
    if (!sid) return;
    const before = state.sessions[sid] || 0;
    const total = Math.max(before, res.costTotal || 0); // resumed sessions report their whole conversation
    state.counters.costUsd += total - before;
    state.sessions[sid] = total;
  }

  infraFailure(runRec, res) {
    const { state, limits } = this;
    state.counters.infraFailures += 1;
    this.lastInfraText = tail(res.text || res.stderr || '', 12, 1200);
    this.backoffMs = limits.infraBackoffSec * 1000 * state.counters.infraFailures;
    this.H.event('infra_failure', { run: runRec.id, role: runRec.role, task: runRec.taskId, text: this.lastInfraText.slice(0, 300) });
    log(`${runRec.id} ${runRec.role} failed to run (${state.counters.infraFailures}/${limits.infraFailuresBeforeStop}): ${this.lastInfraText.split('\n').pop()}`);
  }

  ingest(out, from) {
    const { state } = this;
    addLessons(state, out.lessons, from.task || from.role);
    addQuestions(state, out.questions, from);
    const found = addDiscovered(state, out.discovered_issues, from.task || from.role, this.limits.maxDiscoveredFixes);
    if (found.some((id) => state.issues[id].status === 'open')) state.triage.pending = true;
  }

  /** The main checkout must stay clean or merges fail. Anything a main-lane run left behind is stashed, not lost. */
  tidyMain(who) {
    const ref = stashStrays(this.H, `harness: stray changes left by the ${who}`);
    if (ref) {
      this.H.event('main_checkout_tidied', { who });
      log(`warning: the ${who} left changes in the main checkout; they were stashed (see \`git stash list\`)`);
    }
  }

  // ---- completion handlers ----------------------------------------------------

  onDone(runRec, res) {
    const t = runRec.taskId ? this.state.tasks[runRec.taskId] : null;
    this.H.event('run_finished', { run: runRec.id, kind: runRec.kind, task: runRec.taskId, infra: res.infra || undefined, exit: res.exitCode ?? res.code });
    switch (runRec.kind) {
      case 'plan':
        return this.onPlan(runRec, res);
      case 'build':
        return this.onBuild(runRec, res, t);
      case 'gate':
        return this.onGate(runRec, res, t);
      case 'review':
        return this.onReview(runRec, res, t);
      case 'premerge':
        return this.onPremerge(runRec, res, t);
      case 'verify':
        return this.onVerify(runRec, res);
      case 'triage':
        return this.onTriage(runRec, res);
      default:
        return undefined;
    }
  }

  onPlan(runRec, res) {
    const { state, H } = this;
    const plan = state.plan;
    this.account(runRec, res);
    if (res.infra || !res.output) {
      if (res.infra) this.infraFailure(runRec, res);
      plan.failures += 1;
      if (plan.runs > 0) plan.replans = Math.max(0, plan.replans - 1);
      if (plan.failures >= 3) this.stop('plan_failed', tail(res.text, 15));
      return;
    }
    state.counters.infraFailures = 0;
    const errors = validatePlan(state, res.output);
    if (errors.length) {
      if (this.stopping) return; // leave the plan unapplied; the next run plans again
      if (plan.repairs < 2) {
        plan.repairs += 1;
        log(`plan rejected by validation (${errors.length} problem(s)); asking the planner to repair it`);
        this.startAgentRun({
          role: 'planner',
          prompt: planRepairPrompt(errors),
          cwd: H.root,
          lane: 'main',
          kind: 'plan',
          sessionId: runRec.sessionId,
          resume: true,
          schema: SCHEMAS.plan,
        });
        return;
      }
      this.stop('plan_invalid', errors.map((e) => `- ${e}`).join('\n'));
      return;
    }
    const applied = applyPlan(state, res.output);
    for (const id of applied.cancelled) {
      const t = state.tasks[id];
      if (![...this.active.values()].some((r) => r.taskId === id)) removeWorktree(H, t, { keepBranch: true });
    }
    this.ingest(res.output, { role: 'planner' });
    plan.runs += 1;
    plan.repairs = 0;
    plan.failures = 0;
    plan.needsReplan = false;
    plan.reason = null;
    plan.summary = res.output.summary;
    commitDocs(H, plan.runs === 1 ? 'docs: architecture and initial plan' : 'docs: replan');
    this.tidyMain('planner');
    H.event('plan_applied', { created: applied.created.length, cancelled: applied.cancelled.length, retried: applied.retried.length });
    log(`plan applied: ${applied.created.length} new, ${applied.cancelled.length} cancelled, ${applied.retried.length} retried`);
    state.phase = 'building';
    if (this.cfg.humanGates.plan && !plan.approved) this.stop('plan_review');
  }

  onBuild(runRec, res, t) {
    const { state, H } = this;
    this.account(runRec, res);
    if (!t || t.status !== 'building') {
      if (t?.status === 'cancelled') removeWorktree(H, t, { keepBranch: true });
      return;
    }
    if (res.infra) {
      this.infraFailure(runRec, res);
      t.attempt = Math.max(0, t.attempt - 1); // the session never really ran: do not burn an attempt
      t.thread.dead = true; // the session may not exist: start a fresh one next time
      t.status = t.prevStatus === 'rework' ? 'rework' : 'todo';
      return;
    }
    state.counters.infraFailures = 0;
    autosave(t.worktree, `wip(${t.id}): save uncommitted work`);
    const reverted = revertProtected(H, t);
    if (reverted.length) this.note(t, 'protected_paths_restored', { files: reverted.join(' ') });
    const out = res.output || {};
    t.thread.turns = res.turns;
    if (out.summary) t.summary = out.summary;
    if (out.handoff) t.handoff = out.handoff;
    this.ingest(out, { task: t.id, role: runRec.role });
    if (out.status === 'blocked') {
      const q = (out.questions || []).find((x) => x.blocking);
      this.block(t, 'needs_human', q?.question || out.summary || 'The session reported that it cannot proceed.');
      return;
    }
    if (out.status === 'partial') {
      // The session gave up on purpose. Continue with a fresh one, seeded by its handoff.
      t.thread.dead = true;
      this.rework(t, 'partial', [out.summary, ...(out.handoff?.remaining || []).map((x) => `- ${x}`)].filter(Boolean).join('\n'));
      return;
    }
    if (commitsAhead(H, t) === 0) {
      this.rework(t, 'no_changes', tail(res.text, 15) || 'Nothing was committed.');
      return;
    }
    t.status = 'built';
    this.note(t, 'built', { turns: res.turns, timedOut: res.timedOut || undefined });
  }

  parseJsonTail(res) {
    for (const line of String(res.stdout || '').trim().split('\n').reverse()) {
      try {
        const j = JSON.parse(line);
        if (j && typeof j === 'object') return j;
      } catch {
        /* not the JSON line */
      }
    }
    return null;
  }

  onGate(runRec, res, t) {
    if (!t || t.status !== 'gating') return;
    const g = this.parseJsonTail(res);
    if (!g?.ok) {
      this.rework(t, 'gate_failed', gateFailureText(g, tail(res.stderr || res.stdout, 30)));
      return;
    }
    t.gatedSha = headSha(t.worktree);
    // Work that was already approved and only came back to resolve a conflict or a pre-merge
    // failure does not need a second review: the full gate still runs before it lands.
    if (t.approvedOnce && ['conflict', 'premerge_failed'].includes(t.lastFailure?.kind)) this.approve(t);
    else {
      t.status = 'gated';
      this.note(t, 'gate_passed');
    }
  }

  onReview(runRec, res, t) {
    this.account(runRec, res);
    if (!t || t.status !== 'reviewing') return;
    if (t.gatedSha && t.worktree && fs.existsSync(t.worktree)) resetTo(t.worktree, t.gatedSha); // reviews are read-only
    if (res.infra || !res.output?.verdict) {
      if (res.infra) this.infraFailure(runRec, res);
      t.reviewFailures += 1;
      if (t.reviewFailures >= 3) this.block(t, 'review_unavailable', tail(res.text, 10));
      else t.status = 'gated';
      return;
    }
    this.state.counters.infraFailures = 0;
    const out = res.output;
    const findings = Array.isArray(out.findings) ? out.findings : [];
    const blocking = findings.filter((f) => f.severity === 'blocker' || f.severity === 'major');
    t.review = { verdict: out.verdict, summary: out.summary, at: now(), nits: findings.filter((f) => !blocking.includes(f)).slice(0, 15) };
    this.ingest(out, { task: t.id, role: 'reviewer' });
    // Only blocker and major findings can send work back. Everything else is recorded, not looped on.
    if (out.verdict === 'request_changes' && blocking.length) {
      const text = blocking.map((f) => `[${f.severity}] ${f.file ? `${f.file}: ` : ''}${f.issue}${f.fix ? `\n  Suggested fix: ${f.fix}` : ''}`).join('\n');
      this.rework(t, 'review', `${out.summary || ''}\n\n${text}`.trim());
    } else this.approve(t);
  }

  onPremerge(runRec, res, t) {
    if (!t || t.status !== 'premerge') return;
    const g = this.parseJsonTail(res);
    if (g?.ok) {
      t.premergeOkSha = headSha(t.worktree);
      t.status = 'approved'; // still at the head of the queue; the next tick lands it
      this.note(t, 'premerge_passed');
    } else this.rework(t, 'premerge_failed', gateFailureText(g, tail(res.stderr || res.stdout, 30)));
  }

  onVerify(runRec, res) {
    const { state, limits } = this;
    this.tidyMain('verification');
    const ver = state.verify;
    const pending = ver.pending || { sha: baseSha(this.H), milestones: [] };
    ver.pending = null;
    ver.cycles += 1;
    const v = this.parseJsonTail(res) || {
      ok: false,
      steps: [{ name: 'verify-runner', ok: false, tail: tail(res.stderr || res.stdout, 30) || 'The verification runner produced no result.' }],
      acs: null,
      captured: {},
    };
    ver.lastSha = pending.sha;
    ver.lastOk = v.ok;
    ver.milestonesDone = pending.milestones;
    if (v.captured?.STAGING_URL) ver.stagingUrl = v.captured.STAGING_URL;

    const failing = new Set();
    // A failing e2e step is explained when its report names failing criteria: the ones that are
    // due became issues below, the rest belong to tasks that have not merged yet.
    const reportShowsFailures = !!v.acs && Object.values(v.acs).includes('fail');
    const e2eTail = v.steps.find((s) => s.acReport && !s.ok)?.tail || '';
    if (v.acs) {
      for (const [id, ac] of Object.entries(state.acs)) ac.status = v.acs[id] || 'unknown';
      for (const id of expectedAcs(state)) {
        const ac = state.acs[id];
        if (ac.status === 'pass') continue;
        failing.add(`ac:${id}`);
        const why =
          v.acs[id] === 'fail'
            ? `An e2e test for ${id} failed against staging.`
            : `No e2e test that ran mentions ${id}. Every criterion needs a passing test whose title contains its id (skipped tests do not count).`;
        upsertFailure(
          state,
          `ac:${id}`,
          { title: `${id} does not pass on staging: ${ac.text}`, severity: ac.priority === 'must' ? 'P0' : 'P2', evidence: `${why}\n\n${e2eTail}`.trim(), acceptance: [id] },
          limits.maxIssueRecurrence,
        );
      }
    } else {
      // Verification died before the e2e report existed: criteria keep their previous status
      // and their open issues stay open.
      for (const i of Object.values(state.issues)) if (i.source === 'verify' && i.status !== 'closed' && i.fingerprint.startsWith('ac:')) failing.add(i.fingerprint);
    }
    for (const s of v.steps) {
      if (s.ok || (s.acReport && reportShowsFailures)) continue;
      failing.add(`step:${s.name}`);
      upsertFailure(state, `step:${s.name}`, { title: `Verification step "${s.name}" fails`, severity: 'P0', evidence: s.tail || '' }, limits.maxIssueRecurrence);
    }
    const closed = closeResolved(state, failing);

    const fp = failureFingerprint([...failing].filter((f) => blockingIssues(state).some((i) => i.fingerprint === f)));
    ver.stall = fp && fp === ver.lastFingerprint ? ver.stall + 1 : 0;
    ver.lastFingerprint = fp;
    ver.history.push({ at: now(), sha: pending.sha, ok: v.ok, steps: v.steps.map(({ name, ok, skipped }) => ({ name, ok, skipped })), failing: [...failing] });
    if (ver.history.length > 20) ver.history.shift();
    this.H.event('verified', { sha: pending.sha.slice(0, 7), ok: v.ok, failing: [...failing].join(' '), closed: closed.join(' ') });
    log(`verification ${v.ok ? 'passed' : 'failed'}${failing.size ? `: ${[...failing].join(', ')}` : ''}`);

    state.phase = 'building';
    if (isDone(state)) {
      state.phase = 'done';
      this.stop('done');
      return;
    }
    if (fp && ver.stall >= limits.stallCycles) {
      if (state.plan.replans < limits.maxReplans) {
        state.plan.needsReplan = true;
        state.plan.reason = `Stalled: the same failures (${fp}) survived ${ver.stall + 1} verification cycles. Change the approach.`;
        ver.stall = 0;
      } else {
        this.stop('stalled', `Still failing after ${ver.stall + 1} cycles: ${fp}`);
        return;
      }
    }
    if (untriaged(state).length) state.triage.pending = true;
  }

  onTriage(runRec, res) {
    const { state } = this;
    this.account(runRec, res);
    this.tidyMain('triager');
    state.triage.pending = false;
    const sent = (runRec.issueIds || []).map((id) => state.issues[id]).filter(Boolean);
    if (res.infra) this.infraFailure(runRec, res);
    else state.counters.infraFailures = 0;
    const out = res.output;
    for (const spec of out?.tasks || []) {
      const fixes = (spec.fixes || []).filter((id) => state.issues[id] && state.issues[id].status === 'open');
      if (!fixes.length || !spec.title) continue; // a fix task must point at an open issue: no scope creep
      const acceptance = [...new Set(fixes.flatMap((id) => state.issues[id].acceptance))];
      const t = newTask(state, { ...spec, kind: 'fix', milestone: 'FIXES', acceptance });
      for (const id of fixes) state.issues[id].fixTasks.push(t.id);
      this.note(t, 'fix_task_created', { fixes: fixes.join(' ') });
    }
    if (out) this.ingest(out, { role: 'triager' });
    if (!res.infra) {
      for (const i of sent) {
        if (i.fixTasks.length) continue;
        i.triageAttempts += 1;
        if (i.triageAttempts >= 2) i.status = 'stuck';
      }
    }
    if (untriaged(state).length) state.triage.pending = true;
  }

  // ---- recovery, diagnosis, main loop ------------------------------------------

  /** Put tasks whose child died (crash, Ctrl+C, reboot) back into a state the scheduler understands. */
  normalize() {
    const { state } = this;
    for (const t of tasksOf(state)) {
      if (t.status === 'building') {
        t.attempt = Math.max(0, t.attempt - 1);
        const prev = t.lastFailure;
        t.lastFailure = {
          kind: 'interrupted',
          detail: prev && prev.kind !== 'interrupted' ? `It was addressing this (${prev.kind}):\n${prev.detail}` : prev?.detail || 'No further detail.',
          at: now(),
        };
        t.status = 'rework';
      } else if (t.status === 'gating') t.status = 'built';
      else if (t.status === 'reviewing') t.status = 'gated';
      else if (t.status === 'premerge') t.status = 'approved';
      if (t.worktree && fs.existsSync(t.worktree) && ACTIVE_STATUSES.includes(t.status)) autosave(t.worktree, `wip(${t.id}): save interrupted work`);
    }
    const approved = tasksOf(state)
      .filter((t) => t.status === 'approved')
      .map((t) => t.id);
    state.mergeQueue = [...state.mergeQueue.filter((id) => approved.includes(id)), ...approved.filter((id) => !state.mergeQueue.includes(id))];
    state.verify.pending = null;
  }

  recover() {
    for (const r of loadRuns(this.H)) if (pidAlive(r.pid)) killTree(r.pid, 'SIGTERM');
    saveRuns(this.H, []);
    this.normalize();
  }

  diagnose() {
    const { state } = this;
    if (isDone(state)) return { reason: 'done', detail: '' };
    const lines = [];
    for (const t of tasksOf(state).filter((t) => t.status === 'blocked' && t.role !== 'cleaner')) lines.push(`- ${t.id} is blocked (${t.blocked?.reason}).`);
    for (const i of Object.values(state.issues).filter((i) => i.status === 'stuck')) lines.push(`- ${i.id} is stuck: ${i.title}`);
    for (const t of starvedTasks(state)) lines.push(`- ${t.id} waits on a blocked task.`);
    for (const q of state.inbox.filter((q) => q.status === 'open' && q.blocking)) lines.push(`- ${q.id} needs an answer.`);
    if (lines.length) return { reason: 'needs_human', detail: lines.join('\n') };
    if (state.verify.cycles >= this.limits.maxVerifyCycles) return { reason: 'verify_cycles_exhausted', detail: '' };
    if (this.cfg.humanGates.plan && !state.plan.approved) return { reason: 'plan_review', detail: '' };
    return { reason: 'idle', detail: 'See STATE.md: some "must" criterion is neither passing nor covered by runnable work.' };
  }

  abort() {
    if (this.aborting) process.exit(130);
    this.aborting = true;
    log('interrupted: stopping children and saving work (press Ctrl+C again to force quit)');
    for (const r of this.active.values()) if (r.pid) killTree(r.pid, 'SIGTERM');
  }

  async main() {
    const { H, state } = this;
    state.stop = null;
    if (state.phase === 'stopped' || state.phase === 'init') state.phase = state.plan.runs ? 'building' : 'planning';
    state.counters.startedAt ??= now();
    state.counters.infraFailures = 0;
    state.verify.stall = 0;
    state.plan.repairs = 0;
    state.plan.failures = 0;
    this.recover();
    syncAcs(state, parsePrd(fs.readFileSync(path.join(H.root, this.cfg.project.prd), 'utf8')));
    const orphans = orphanedMust(state);
    if (state.plan.runs > 0 && orphans.length && !state.plan.needsReplan) {
      state.plan.needsReplan = true;
      state.plan.reason = `No task covers ${orphans.join(', ')} (new or changed in the PRD).`;
      state.plan.replans = Math.max(0, state.plan.replans - 1); // a PRD change never counts against the budget
    }
    H.event('loop_started', { pid: process.pid });

    for (;;) {
      let guard = 0;
      while (!this.stopping && !this.aborting && this.tick() && guard++ < 200);
      this.persist();
      if (this.active.size === 0) {
        if (!this.stopping) this.stopping = this.aborting ? { reason: 'interrupted', detail: '' } : this.diagnose();
        break;
      }
      const { run: runRec, result } = await Promise.race([...this.active.values()].map((r) => r.promise));
      this.active.delete(runRec.id);
      saveRuns(H, [...this.active.values()]);
      if (this.aborting) continue; // children were killed on purpose; normalize() sorts the tasks out below
      try {
        this.onDone(runRec, result);
      } catch (err) {
        this.stop('internal_error', String(err?.stack || err));
      }
      if (this.backoffMs && !this.stopping) {
        this.persist();
        await sleep(this.backoffMs);
      }
      this.backoffMs = 0;
    }

    if (this.aborting) this.normalize();
    state.stop = { ...this.stopping, at: now() };
    state.phase = this.stopping.reason === 'done' ? 'done' : 'stopped';
    this.persist();
    H.event('loop_stopped', { reason: this.stopping.reason });
    return this.stopping;
  }
}

export async function runLoop(root, opts = {}) {
  const H = openHarness(root);
  const caps = detectClaude(H.cfg);
  const { errors, warnings } = preflight(H, caps);
  for (const w of warnings) log(`warning: ${w}`);
  if (errors.length) throw new Error(`cannot start:\n- ${errors.join('\n- ')}`);
  const release = acquireLock(H);
  clearStop(H);
  const loop = new Loop(H, { ...opts, caps });
  const onSignal = () => loop.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const stop = await loop.main();
    log(`loop stopped: ${stop.reason}. ${stopText(stop.reason)}`);
    if (stop.detail) console.log(stop.detail);
    log('see STATE.md and HANDOFF.md');
    return stop;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    release();
  }
}
