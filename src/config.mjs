// Configuration: defaults, stack presets, loading.
import fs from 'node:fs';
import path from 'node:path';
import { deepMerge, readJson } from './util.mjs';

export const HARNESS_DIR = '.harness';
export const configPath = (root) => path.join(root, HARNESS_DIR, 'config.json');

/** Stack-agnostic defaults. Everything here can be overridden in .harness/config.json. */
export const DEFAULTS = {
  version: 1,
  project: {
    name: '',
    baseBranch: 'main',
    prd: 'docs/PRD.md',
  },
  claude: {
    bin: 'claude',
    // auto: a classifier reviews each action. Alternatives: "acceptEdits" (relies on the
    // allow rules in .claude/settings.json) or "bypassPermissions" (containers/VMs only).
    permissionMode: 'auto',
    extraArgs: [],
  },
  roles: {
    planner: { agent: 'planner', model: null, effort: null, maxTurns: 80, maxBudgetUsd: 6, timeoutMin: 30 },
    builder: { agent: 'builder', model: null, effort: null, maxTurns: 250, maxBudgetUsd: 12, timeoutMin: 75 },
    reviewer: { agent: 'reviewer', model: null, effort: null, maxTurns: 60, maxBudgetUsd: 4, timeoutMin: 20 },
    triager: { agent: 'triager', model: null, effort: null, maxTurns: 60, maxBudgetUsd: 4, timeoutMin: 20 },
    cleaner: { agent: 'cleaner', model: null, effort: null, maxTurns: 120, maxBudgetUsd: 6, timeoutMin: 40 },
  },
  limits: {
    concurrency: 2, // task-lane runs in parallel (build / quick gate / review)
    maxAttemptsPerTask: 4, // builder cycles before a task is blocked
    maxResumesPerSession: 2, // feedback rounds on one session before rotating to a fresh one
    maxReplans: 2, // planner re-entries caused by blocked tasks or stalls
    maxIssueRecurrence: 3, // same failure surviving this many fixes => stuck, ask a human
    maxDiscoveredFixes: 8, // serious problems reported by agents that may get a fix task; the rest go to the backlog
    maxVerifyCycles: 12,
    stallCycles: 2, // identical failure set across this many verifies => stalled
    maxRuns: 300, // agent sessions in total
    maxCostUsd: 200,
    maxHours: 48,
    cleanEveryMerges: 6, // schedule the cleaner after this many merges
    infraFailuresBeforeStop: 3, // consecutive agent runtime failures (auth, rate limit, crash)
    infraBackoffSec: 30,
    gateTimeoutMin: 30,
  },
  worktrees: {
    root: '../{repo}.worktrees', // outside the repo so nested CLAUDE.md / tooling never see two copies
    setup: [], // commands run once in a new worktree
    copy: [], // untracked files copied from the main checkout (e.g. ".env")
    portBase: 4100,
    portStride: 10,
    env: {}, // per-worktree env; supports {port}, {port+N}, {worktree}, {root}, {slot}, {task}
  },
  // Each gate: { name, cmd, quick?: bool, areas?: [..], if?: "path that must exist" }
  // Quick gates run after every builder session (filtered by task area).
  // The full set (all gates) runs on the merged tree before anything lands on the base branch.
  gates: [],
  verify: {
    // Steps run on the base branch. requires: path that must exist (else the step fails).
    // capture: { ENV_NAME: "regex with one group" } exports values to later steps.
    steps: [],
    acReport: { path: 'e2e/report.json', format: 'playwright-json' },
  },
  protectedPaths: ['.harness/**', '.claude/**', 'STATE.md', 'HANDOFF.md', 'docs/PRD.md'],
  // Roles allowed to edit CLAUDE.md. Everyone else is blocked by the guard hook.
  claudeMdEditors: ['planner', 'cleaner'],
  humanGates: {
    plan: false, // true: stop after planning until `harness approve plan`
  },
};

export const PRESETS = {
  generic: {},
  'nextjs-rust-sqlite': {
    worktrees: {
      setup: [
        'if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile --prefer-offline; fi',
        'if [ -f server/Cargo.toml ]; then cargo fetch --manifest-path server/Cargo.toml; fi',
      ],
      copy: ['.env', 'web/.env.local', 'server/.env'],
      env: {
        WEB_PORT: '{port}',
        API_PORT: '{port+1}',
        DATABASE_URL: 'sqlite://{worktree}/data/dev.db',
        // One shared target dir: cargo serialises on its lock but every worktree reuses the cache.
        CARGO_TARGET_DIR: '{root}/.harness/runtime/cargo-target',
      },
    },
    gates: [
      { name: 'web:lint', cmd: 'pnpm -C web run lint', quick: true, areas: ['web'], if: 'web/package.json' },
      { name: 'web:typecheck', cmd: 'pnpm -C web run typecheck', quick: true, areas: ['web'], if: 'web/package.json' },
      { name: 'web:unit', cmd: 'pnpm -C web run test', quick: true, areas: ['web'], if: 'web/package.json' },
      {
        name: 'server:fmt',
        cmd: 'cargo fmt --manifest-path server/Cargo.toml --all -- --check',
        quick: true,
        areas: ['server', 'db'],
        if: 'server/Cargo.toml',
      },
      {
        name: 'server:clippy',
        cmd: 'cargo clippy --manifest-path server/Cargo.toml --all-targets -- -D warnings',
        quick: true,
        areas: ['server', 'db'],
        if: 'server/Cargo.toml',
      },
      {
        name: 'server:test',
        cmd: 'cargo test --manifest-path server/Cargo.toml',
        quick: true,
        areas: ['server', 'db'],
        if: 'server/Cargo.toml',
      },
      { name: 'web:build', cmd: 'pnpm -C web run build', if: 'web/package.json' },
      { name: 'server:build', cmd: 'cargo build --release --manifest-path server/Cargo.toml', if: 'server/Cargo.toml' },
      { name: 'e2e:local', cmd: 'pnpm -C e2e run test:local', if: 'e2e/package.json' },
    ],
    verify: {
      steps: [
        {
          name: 'deploy-staging',
          cmd: 'bash scripts/deploy-staging.sh',
          requires: 'scripts/deploy-staging.sh',
          capture: { STAGING_URL: 'STAGING_URL=(\\S+)' },
        },
        { name: 'e2e-staging', cmd: 'pnpm -C e2e run test:staging', requires: 'e2e/package.json', acReport: true },
      ],
      acReport: { path: 'e2e/report.json', format: 'playwright-json' },
    },
  },
};

export function buildConfig(preset = 'generic', overrides = {}) {
  if (!PRESETS[preset]) throw new Error(`unknown preset "${preset}" (have: ${Object.keys(PRESETS).join(', ')})`);
  return deepMerge(deepMerge(DEFAULTS, PRESETS[preset]), overrides);
}

export function loadConfig(root) {
  const file = configPath(root);
  if (!fs.existsSync(file)) {
    throw new Error(`no ${HARNESS_DIR}/config.json in ${root}. Run \`harness init\` in your project first.`);
  }
  const cfg = deepMerge(DEFAULTS, readJson(file));
  const problems = [];
  if (!Array.isArray(cfg.gates)) problems.push('gates must be an array');
  for (const g of cfg.gates || []) if (!g.name || !g.cmd) problems.push(`gate needs name and cmd: ${JSON.stringify(g)}`);
  for (const s of cfg.verify?.steps || []) if (!s.name || !s.cmd) problems.push(`verify step needs name and cmd: ${JSON.stringify(s)}`);
  for (const role of ['planner', 'builder', 'reviewer', 'triager', 'cleaner']) {
    if (!cfg.roles[role]) problems.push(`roles.${role} missing`);
  }
  if (problems.length) throw new Error(`invalid ${file}:\n- ${problems.join('\n- ')}`);
  return cfg;
}

/** Resolve the worktree root directory for a repository. */
export function worktreeRoot(root, cfg) {
  const repo = path.basename(root);
  return path.resolve(root, cfg.worktrees.root.replaceAll('{repo}', repo));
}
