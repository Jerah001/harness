// Persistent state. The orchestrator process is the only writer.
//
//   .harness/config.json     tracked    how the loop behaves
//   .harness/state.json      untracked  the task graph, issues, inbox, counters
//   .harness/events.jsonl    untracked  append-only audit trail of every transition
//   .harness/runtime/        untracked  lock, active runs, logs, stop flag
//   STATE.md / HANDOFF.md    untracked  rendered from state.json after every transition
import fs from 'node:fs';
import path from 'node:path';
import { HARNESS_DIR, loadConfig } from './config.mjs';
import { now, pidAlive, readJson, writeJson } from './util.mjs';

export function emptyState() {
  return {
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    phase: 'init', // init | planning | building | verifying | done | stopped
    stop: null, // { reason, detail, at }
    acs: {}, // AC-001 -> { text, priority, status: unknown|pass|fail }
    milestones: [],
    tasks: {},
    issues: {},
    inbox: [],
    lessons: [],
    mergeQueue: [],
    plan: { runs: 0, replans: 0, repairs: 0, failures: 0, needsReplan: false, reason: null, approved: false },
    verify: { cycles: 0, lastSha: null, lastOk: null, stall: 0, lastFingerprint: null, milestonesDone: [], history: [], stagingUrl: null },
    triage: { pending: false },
    counters: { runs: 0, costUsd: 0, merges: 0, mergesSinceClean: 0, infraFailures: 0, startedAt: null, activeMs: 0 },
    seq: { task: 0, issue: 0, question: 0, run: 0, clean: 0 },
    sessions: {}, // sessionId -> cumulative cost already accounted
  };
}

export function openHarness(root) {
  const cfg = loadConfig(root);
  const dir = path.join(root, HARNESS_DIR);
  const runtime = path.join(dir, 'runtime');
  fs.mkdirSync(path.join(runtime, 'logs'), { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const state = fs.existsSync(stateFile) ? readJson(stateFile) : emptyState();
  const H = {
    root,
    cfg,
    dir,
    runtime,
    state,
    stateFile,
    save() {
      state.updatedAt = now();
      writeJson(stateFile, state);
    },
    event(type, data = {}) {
      fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ at: now(), type, ...data })}\n`);
    },
    logFile: (name) => path.join(runtime, 'logs', name),
  };
  return H;
}

// ---- single-orchestrator lock -------------------------------------------------

export function acquireLock(H) {
  const file = path.join(H.runtime, 'lock');
  const held = readJson(file, null);
  if (held && held.pid !== process.pid && pidAlive(held.pid)) {
    throw new Error(`another harness loop is running here (pid ${held.pid}). Use \`harness stop\` or wait for it.`);
  }
  writeJson(file, { pid: process.pid, at: now() });
  return () => {
    try {
      const cur = readJson(file, null);
      if (cur?.pid === process.pid) fs.rmSync(file);
    } catch {
      /* ignore */
    }
  };
}

// ---- registry of live child runs (for crash recovery) -------------------------

const runsFile = (H) => path.join(H.runtime, 'runs.json');
export const loadRuns = (H) => readJson(runsFile(H), []);
export const saveRuns = (H, runs) =>
  writeJson(
    runsFile(H),
    runs.map(({ id, kind, role, taskId, sessionId, pid, lane, startedAt }) => ({ id, kind, role, taskId, sessionId, pid, lane, startedAt })),
  );

// ---- stop flag ----------------------------------------------------------------

const stopFile = (H) => path.join(H.runtime, 'stop');
export const stopRequested = (H) => fs.existsSync(stopFile(H));
export const requestStop = (H) => fs.writeFileSync(stopFile(H), now());
export const clearStop = (H) => fs.rmSync(stopFile(H), { force: true });

// ---- id helpers ---------------------------------------------------------------

const pad = (n) => String(n).padStart(3, '0');
export const nextTaskId = (state) => `T-${pad(++state.seq.task)}`;
export const nextIssueId = (state) => `I-${pad(++state.seq.issue)}`;
export const nextQuestionId = (state) => `Q-${pad(++state.seq.question)}`;
export const nextRunId = (state) => `R-${String(++state.seq.run).padStart(4, '0')}`;
