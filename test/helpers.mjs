// Builds a throwaway project wired to the fake `claude` binary.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig } from '../src/config.mjs';
import { init } from '../src/init.mjs';
import { runLoop } from '../src/loop.mjs';
import { deepMerge, readJson, writeJson } from '../src/util.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BIN = path.join(HERE, '..', 'bin', 'harness.mjs');
const FAKE = path.join(HERE, 'fake-claude.mjs');

Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

export const PRD = `# PRD
## Acceptance criteria
- **AC-001** (must) a.txt says good
- **AC-002** (must) b.txt says good
- **AC-003** (should) c.txt exists
`;

// Stand-in e2e suite: writes a report in the "map" format and fails if any criterion fails.
const E2E = `import fs from 'node:fs';
const good = (f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('good');
const r = { 'AC-001': good('a.txt'), 'AC-002': good('b.txt'), 'AC-003': fs.existsSync('c.txt') };
fs.writeFileSync('report.json', JSON.stringify(r));
process.exit(Object.values(r).every(Boolean) ? 0 : 1);
`;

export function project(scenario, overrides = {}, { prd = PRD } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  const root = path.join(base, 'proj');
  const stateDir = path.join(base, 'fake-state');
  const scenarioFile = path.join(base, 'scenario.json');
  fs.mkdirSync(root);
  fs.chmodSync(FAKE, 0o755);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  init(root, { preset: 'generic' });
  const cfg = deepMerge(
    buildConfig('generic', {
      project: { name: 'proj', baseBranch: 'main' },
      claude: { bin: FAKE },
      limits: { infraBackoffSec: 0, cleanEveryMerges: 0 },
      gates: [
        { name: 'no-bad', cmd: '! grep -rqs BAD --include=*.txt .', quick: true },
        { name: 'full-check', cmd: 'test ! -f FAIL_FULL' },
      ],
      verify: {
        steps: [
          { name: 'deploy', cmd: 'echo STAGING_URL=http://staging.test', capture: { STAGING_URL: 'STAGING_URL=(\\S+)' } },
          { name: 'e2e', cmd: 'node e2e.mjs', acReport: true },
        ],
        acReport: { path: 'report.json', format: 'map' },
      },
    }),
    overrides,
  );
  writeJson(path.join(root, '.harness', 'config.json'), cfg);
  fs.writeFileSync(path.join(root, 'docs', 'PRD.md'), prd);
  fs.writeFileSync(path.join(root, 'e2e.mjs'), E2E);
  fs.appendFileSync(path.join(root, '.gitignore'), 'report.json\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: bootstrap');
  const setScenario = (s) => writeJson(scenarioFile, s);
  setScenario(scenario);

  return {
    root,
    git,
    setScenario,
    async run(opts = {}) {
      process.env.FAKE_SCENARIO = scenarioFile;
      process.env.FAKE_STATE = stateDir;
      return runLoop(root, opts);
    },
    cli(...args) {
      return execFileSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8' });
    },
    /** Like cli(), for commands that start sessions and may exit non-zero. */
    cliResult(...args) {
      const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FAKE_SCENARIO: scenarioFile, FAKE_STATE: stateDir } });
      return { code: r.status, out: r.stdout, err: r.stderr };
    },
    state: () => readJson(path.join(root, '.harness', 'state.json')),
    calls: () =>
      fs.existsSync(path.join(stateDir, 'calls.jsonl'))
        ? fs
            .readFileSync(path.join(stateDir, 'calls.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l))
        : [],
    read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    worktrees: () => git('worktree', 'list').split('\n').length - 1,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

export const threeTaskPlan = {
  summary: 'Skeleton first, then two features in parallel.',
  milestones: [
    { id: 'M0', title: 'Skeleton' },
    { id: 'M1', title: 'Features' },
  ],
  tasks: [
    { key: 'a', title: 'Feature A', description: 'make a', area: 'web', milestone: 'M0', acceptance: ['AC-001'], touches: ['a.txt'] },
    { key: 'b', title: 'Feature B', description: 'make b', area: 'server', milestone: 'M1', acceptance: ['AC-002'], touches: ['b.txt'], depends_on: ['a'] },
    { key: 'c', title: 'Feature C', description: 'make c', area: 'web', milestone: 'M1', acceptance: ['AC-003'], touches: ['c.txt'], depends_on: ['a'] },
  ],
};
