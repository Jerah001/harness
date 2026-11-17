// Headless Claude Code sessions: how they are started, what they must return, how results are read.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, tail } from './util.mjs';

export const HARNESS_BIN = fileURLToPath(new URL('../bin/harness.mjs', import.meta.url));

const str = { type: 'string' };
const strs = { type: 'array', items: str };
const questions = {
  type: 'array',
  items: {
    type: 'object',
    required: ['question'],
    properties: { question: str, default: str, blocking: { type: 'boolean' } },
  },
};
const discovered = {
  type: 'array',
  items: {
    type: 'object',
    required: ['title'],
    properties: { title: str, severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }, area: str, detail: str },
  },
};
const AREA = { type: 'string', enum: ['web', 'server', 'db', 'e2e', 'infra', 'docs'] };

/** Every role ends its session with one of these objects (enforced with --json-schema). */
export const SCHEMAS = {
  plan: {
    type: 'object',
    required: ['summary', 'tasks'],
    properties: {
      summary: str,
      milestones: {
        type: 'array',
        items: { type: 'object', required: ['id', 'title'], properties: { id: str, title: str, goal: str } },
      },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          required: ['key', 'title', 'description', 'area'],
          properties: {
            key: str,
            title: str,
            description: str,
            milestone: str,
            area: AREA,
            acceptance: strs,
            done_when: strs,
            depends_on: strs,
            touches: strs,
            size: { type: 'string', enum: ['S', 'M', 'L'] },
            priority: { type: 'string', enum: ['mvp', 'later'] },
          },
        },
      },
      cancel: strs,
      retry: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: str, guidance: str } } },
      questions,
    },
  },
  build: {
    type: 'object',
    required: ['status', 'summary'],
    properties: {
      status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
      summary: str,
      handoff: {
        type: 'object',
        properties: { done: strs, remaining: strs, gotchas: strs, next_step: str },
      },
      lessons: strs,
      questions,
      discovered_issues: discovered,
    },
  },
  review: {
    type: 'object',
    required: ['verdict', 'summary'],
    properties: {
      verdict: { type: 'string', enum: ['approve', 'request_changes'] },
      summary: str,
      findings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['severity', 'issue'],
          properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] }, file: str, issue: str, fix: str },
        },
      },
      discovered_issues: discovered,
    },
  },
  triage: {
    type: 'object',
    required: ['summary', 'tasks'],
    properties: {
      summary: str,
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title', 'description', 'area', 'fixes'],
          properties: { title: str, description: str, area: AREA, fixes: strs, touches: strs, done_when: strs },
        },
      },
      questions,
    },
  },
};

/** Find the installed Claude Code version and what it supports. */
export function detectClaude(cfg) {
  const r = spawnSync(cfg.claude.bin, ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return { found: false, version: null, permissionPrompts: false };
  const m = String(r.stdout).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return { found: true, version: String(r.stdout).trim(), permissionPrompts: false };
  const v = m.slice(1).map(Number);
  const atLeast = (a, b, c) => v[0] > a || (v[0] === a && (v[1] > b || (v[1] === b && v[2] >= c)));
  return { found: true, version: m[0], permissionPrompts: atLeast(2, 1, 259) };
}

export function agentArgs(cfg, caps, { role, prompt, schema, sessionId, resume, name, spentUsd = 0 }) {
  const rc = cfg.roles[role];
  const a = ['-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(schema)];
  if (resume) a.push('--resume', sessionId);
  else {
    a.push('--session-id', sessionId); // chosen up front, so a killed session can still be resumed
    if (rc.agent) a.push('--agent', rc.agent);
    if (name) a.push('--name', name);
  }
  if (cfg.claude.permissionMode) a.push('--permission-mode', cfg.claude.permissionMode);
  if (caps.permissionPrompts) a.push('--permission-prompts', 'none'); // nobody is there to answer
  if (rc.model) a.push('--model', rc.model);
  if (rc.effort) a.push('--effort', rc.effort);
  if (rc.maxTurns) a.push('--max-turns', String(rc.maxTurns));
  // A resumed conversation reports its whole cost, so the cap has to include what it already spent.
  if (rc.maxBudgetUsd) a.push('--max-budget-usd', String(Math.ceil((rc.maxBudgetUsd + spentUsd) * 100) / 100));
  a.push(...(cfg.claude.extraArgs || []));
  return a;
}

/** Start a session. Resolves with a normalised result; never rejects. */
export function startAgent(H, caps, spec) {
  const { cfg } = H;
  const rc = cfg.roles[spec.role];
  const env = {
    ...spec.env,
    HARNESS_ROLE: spec.role,
    HARNESS_TASK_ID: spec.task?.id || '',
    HARNESS_TASK_AREA: spec.task?.area || '',
    HARNESS_RUN_ID: spec.runId,
    HARNESS_ROOT: H.root,
    HARNESS_BIN,
  };
  const proc = run(cfg.claude.bin, agentArgs(cfg, caps, spec), {
    cwd: spec.cwd,
    env,
    timeoutMs: rc.timeoutMin * 60000,
    logFile: H.logFile(`${spec.runId}-${spec.role}.log`),
  });
  return { pid: proc.pid, done: proc.done.then(parseAgentResult) };
}

function parseClaudeJson(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return [...j].reverse().find((m) => m?.type === 'result') || null;
    return j && typeof j === 'object' ? j : null;
  } catch {
    /* fall through to line scan */
  }
  for (const line of s.split('\n').reverse()) {
    try {
      const j = JSON.parse(line);
      if (j && typeof j === 'object' && (j.type === 'result' || 'result' in j)) return j;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

function extractJson(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const j = JSON.parse(c);
      if (j && typeof j === 'object') return j;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const SOFT_ERRORS = ['error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries'];

/**
 * infra = the session itself did not work (not signed in, rate limited, crashed, bad flag).
 * Those must not consume a task's attempts; enough of them in a row stops the loop.
 */
export function parseAgentResult(r) {
  const j = parseClaudeJson(r.stdout);
  let output = j?.structured_output && typeof j.structured_output === 'object' ? j.structured_output : null;
  const structured = !!output; // false when the object had to be dug out of the reply text
  if (!output && typeof j?.result === 'string') output = extractJson(j.result);
  const infra = !r.timedOut && (!j || (j.is_error === true && !SOFT_ERRORS.includes(j.subtype) && !output));
  return {
    output,
    structured,
    infra,
    timedOut: !!r.timedOut,
    exitCode: r.code,
    sessionId: j?.session_id || null,
    costTotal: Number(j?.total_cost_usd || 0),
    turns: Number(j?.num_turns || 0),
    subtype: j?.subtype || null,
    denials: Array.isArray(j?.permission_denials) ? j.permission_denials.length : 0,
    text: typeof j?.result === 'string' && j.result ? j.result : tail(r.stderr || r.stdout, 25, 2500),
  };
}
