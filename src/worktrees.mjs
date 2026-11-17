// One git worktree and branch per task. The orchestrator owns their whole life cycle:
// create, give each a port block, save stray work, sync with the base branch, land, remove.
import fs from 'node:fs';
import path from 'node:path';
import { worktreeRoot } from './config.mjs';
import { git, matchAny, sh, tail } from './util.mjs';

export const baseSha = (H) => git(['rev-parse', H.cfg.project.baseBranch], H.root).out;
export const headSha = (dir) => git(['rev-parse', 'HEAD'], dir).out;
export const branchName = (task) => `task/${task.id}`;

/** Use the person's git identity when there is one; otherwise commit as "harness". */
function ident(dir) {
  const has = git(['config', 'user.email'], dir, { allowFail: true }).out;
  return has ? [] : ['-c', 'user.name=harness', '-c', 'user.email=harness@localhost'];
}

function allocateSlot(state, taskId) {
  const used = new Set(
    Object.values(state.tasks)
      .filter((t) => t.id !== taskId && t.worktree && t.slot != null)
      .map((t) => t.slot),
  );
  let slot = 0;
  while (used.has(slot)) slot += 1;
  return slot;
}

/** Per-worktree environment: a private port block and database so parallel tasks never collide. */
export function worktreeEnv(H, task) {
  const w = H.cfg.worktrees;
  const port = w.portBase + (task.slot ?? 0) * w.portStride;
  const fill = (v) =>
    String(v)
      .replace(/\{port\+(\d+)\}/g, (_, n) => String(port + Number(n)))
      .replaceAll('{port}', String(port))
      .replaceAll('{worktree}', task.worktree || '')
      .replaceAll('{root}', H.root)
      .replaceAll('{slot}', String(task.slot ?? 0))
      .replaceAll('{task}', task.id);
  const env = {};
  for (const [k, v] of Object.entries(w.env || {})) env[k] = fill(v);
  return env;
}

/** Create the task's worktree if it is missing (reusing its branch when that survived). */
export function ensureWorktree(H, task) {
  const { root, cfg, state } = H;
  const dir = path.join(worktreeRoot(root, cfg), task.id);
  const branch = branchName(task);
  let created = false;
  if (!fs.existsSync(path.join(dir, '.git'))) {
    git(['worktree', 'prune'], root, { allowFail: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const hasBranch = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root, { allowFail: true }).code === 0;
    if (hasBranch) git(['worktree', 'add', dir, branch], root);
    else git(['worktree', 'add', '-b', branch, dir, cfg.project.baseBranch], root);
    created = true;
  }
  task.branch = branch;
  task.worktree = dir;
  if (task.slot == null) task.slot = allocateSlot(state, task.id);
  if (created) {
    for (const rel of cfg.worktrees.copy || []) {
      const src = path.join(root, rel);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.copyFileSync(src, path.join(dir, rel));
    }
    const env = worktreeEnv(H, task);
    for (const cmd of cfg.worktrees.setup || []) {
      const r = sh(cmd, { cwd: dir, env, timeoutMs: 20 * 60000 });
      if (r.code !== 0) H.event('worktree_setup_failed', { task: task.id, cmd, tail: tail(r.out, 20) });
    }
  }
  return dir;
}

/** Commit anything a session left uncommitted, so no work is ever lost between sessions. */
export function autosave(dir, message) {
  if (!dir || !fs.existsSync(dir)) return false;
  if (!git(['status', '--porcelain'], dir, { allowFail: true }).out) return false;
  git(['add', '-A'], dir, { allowFail: true });
  git([...ident(dir), 'commit', '-q', '--no-verify', '-m', message], dir, { allowFail: true });
  return true;
}

export const commitsAhead = (H, task) =>
  Number(git(['rev-list', '--count', `${H.cfg.project.baseBranch}..HEAD`], task.worktree, { allowFail: true }).out || 0);

export const changedFiles = (H, task) =>
  git(['diff', '--name-only', `${H.cfg.project.baseBranch}...HEAD`], task.worktree, { allowFail: true })
    .out.split('\n')
    .filter(Boolean);

/**
 * Enforce path ownership after the fact. Hooks stop most edits to protected paths, but a shell
 * command can still write anywhere, so whatever reaches the branch is put back before review.
 */
export function revertProtected(H, task) {
  const { cfg } = H;
  const base = cfg.project.baseBranch;
  const dir = task.worktree;
  const protectedGlobs = [...cfg.protectedPaths, ...(cfg.claudeMdEditors.includes(task.role) ? [] : ['CLAUDE.md'])];
  const bad = changedFiles(H, task).filter((f) => matchAny(protectedGlobs, f));
  for (const f of bad) {
    const onBase = git(['cat-file', '-e', `${base}:${f}`], dir, { allowFail: true }).code === 0;
    if (onBase) git(['checkout', base, '--', f], dir, { allowFail: true });
    else git(['rm', '-q', '-f', '--', f], dir, { allowFail: true });
  }
  if (bad.length) {
    git([...ident(dir), 'commit', '-q', '--no-verify', '-m', `chore(${task.id}): restore protected paths`], dir, { allowFail: true });
  }
  return bad;
}

/** Bring the base branch into the task branch. A conflict is aborted and reported, never left half-done. */
export function syncBase(H, task) {
  const base = H.cfg.project.baseBranch;
  const dir = task.worktree;
  if (git(['merge-base', '--is-ancestor', base, 'HEAD'], dir, { allowFail: true }).code === 0) return { ok: true, moved: false };
  const r = git([...ident(dir), 'merge', '--no-edit', '-m', `Merge ${base} into ${task.branch}`, base], dir, { allowFail: true });
  if (r.code === 0) return { ok: true, moved: true };
  const files = git(['diff', '--name-only', '--diff-filter=U'], dir, { allowFail: true }).out;
  git(['merge', '--abort'], dir, { allowFail: true });
  return { ok: false, detail: files || r.err || r.out };
}

/** Land a task on the base branch. Only called for a branch that already contains the base tip. */
export function mergeToBase(H, task) {
  const { root, cfg } = H;
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], root).out;
  if (current !== cfg.project.baseBranch) {
    throw new Error(`the main checkout is on "${current}", expected "${cfg.project.baseBranch}". Leave it on the base branch while the loop runs.`);
  }
  git([...ident(root), 'merge', '--no-ff', '--no-edit', '-m', `${task.id}: ${task.title}`, task.branch], root);
  return headSha(root);
}

export function removeWorktree(H, task, { keepBranch = false } = {}) {
  if (task.worktree && fs.existsSync(task.worktree)) git(['worktree', 'remove', '--force', task.worktree], H.root, { allowFail: true });
  git(['worktree', 'prune'], H.root, { allowFail: true });
  if (task.branch && !keepBranch) git(['branch', '-D', task.branch], H.root, { allowFail: true });
  task.worktree = null;
  task.slot = null;
}

/** Put a worktree back to a known commit (used after read-only sessions such as review). */
export function resetTo(dir, sha) {
  git(['reset', '-q', '--hard', sha], dir, { allowFail: true });
}

/** Commit documentation the planner wrote in the main checkout. */
export function commitDocs(H, message) {
  const { root } = H;
  const paths = ['docs', 'CLAUDE.md'].filter((p) => fs.existsSync(path.join(root, p)));
  if (!paths.length) return false;
  git(['add', '-A', '--', ...paths], root, { allowFail: true });
  git(['reset', '-q', '--', H.cfg.project.prd], root, { allowFail: true }); // the PRD stays human-owned
  if (git(['diff', '--cached', '--quiet'], root, { allowFail: true }).code === 0) return false;
  git([...ident(root), 'commit', '-q', '--no-verify', '-m', message], root, { allowFail: true });
  return true;
}

/** Cheap, deterministic hints for the reviewer about where checks may have been weakened. */
export function diffSignals(H, task) {
  const base = H.cfg.project.baseBranch;
  const dir = task.worktree;
  const range = `${base}...HEAD`;
  const stat = git(['diff', '--stat', range], dir, { allowFail: true }).out;
  const files = changedFiles(H, task);
  const added = git(['diff', '-U0', range], dir, { allowFail: true })
    .out.split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const weakened = added
    .filter((l) =>
      /\b(test|it|describe)\.(skip|only|fixme)\b|\bx(it|describe)\(|#\[ignore\]|eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|#!?\[allow\(/.test(l),
    )
    .slice(0, 20);
  const deletedTests = git(['diff', '--name-only', '--diff-filter=D', range], dir, { allowFail: true })
    .out.split('\n')
    .filter((f) => /(\.|_)(test|spec)\.|(^|\/)tests?\//.test(f));
  const checkConfig = files.filter(
    (f) =>
      /(^|\/)(package\.json|playwright\.config\.[cm]?[tj]s|vitest\.config\.[cm]?[tj]s|Cargo\.toml|\.eslintrc[^/]*|eslint\.config\.[^/]+|tsconfig[^/]*\.json|clippy\.toml|rustfmt\.toml)$/.test(
        f,
      ) || f.startsWith('scripts/'),
  );
  return { stat, files, weakened, deletedTests, checkConfig };
}

/** Stash whatever is dirty in the main checkout (gitignored files are left alone). */
export function stashStrays(H, message) {
  const { root } = H;
  if (!git(['status', '--porcelain'], root, { allowFail: true }).out) return false;
  const r = git([...ident(root), 'stash', 'push', '--include-untracked', '-q', '-m', message], root, { allowFail: true });
  return r.code === 0;
}
