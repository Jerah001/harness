// Small shared helpers: process execution, git, JSON files, globs.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const now = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function log(...parts) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}]`, ...parts);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
}

export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export const writeJson = (file, obj) => writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');

/** Run a shell command synchronously. Never throws; returns exit code and combined output. */
export function sh(cmd, { cwd, env, timeoutMs = 20 * 60 * 1000 } = {}) {
  const r = spawnSync('bash', ['-c', cmd], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const code = timedOut ? 124 : (r.status ?? 1);
  return { code, out: `${r.stdout || ''}${r.stderr || ''}`, timedOut };
}

/** Run git synchronously. Throws unless allowFail is set. */
export function git(args, cwd, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd} (${r.status}): ${err || out}`);
  }
  return { code: r.status ?? 1, out, err };
}

/** Kill a process group started by run(). */
export function killTree(pid, signal = 'SIGTERM') {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const MAX_CAPTURE = 4 * 1024 * 1024;

/**
 * Start a child process in its own process group and capture its output.
 * Returns { pid, done } where done resolves (never rejects) with the outcome.
 */
export function run(cmd, args, { cwd, env, timeoutMs, logFile } = {}) {
  let child;
  try {
    child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (err) {
    return { pid: null, done: Promise.resolve({ code: 127, stdout: '', stderr: String(err), spawnError: true }) };
  }
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let timer;
  let logStream = null;
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
  }
  const keep = (buf, chunk) => {
    const next = buf + chunk;
    return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
  };
  child.stdout.on('data', (d) => {
    stdout = keep(stdout, d);
    logStream?.write(d);
  });
  child.stderr.on('data', (d) => {
    stderr = keep(stderr, d);
    logStream?.write(d);
  });
  const done = new Promise((resolve) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${err}`, timedOut, spawnError: true });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      logStream?.end();
      resolve({ code: code ?? 128, signal, stdout, stderr, timedOut });
    });
  });
  if (timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, 'SIGINT'); // lets Claude Code end the turn cleanly
      setTimeout(() => killTree(child.pid, 'SIGKILL'), 20000).unref();
    }, timeoutMs);
    timer.unref();
  }
  return { pid: child.pid, done };
}

/** Last N lines of text, bounded in characters, for feeding failures back to an agent. */
export function tail(text, lines = 60, maxChars = 6000) {
  const t = String(text || '').replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
  let out = t.split('\n').slice(-lines).join('\n');
  if (out.length > maxChars) out = `…${out.slice(out.length - maxChars)}`;
  return out;
}

/** Deep merge plain objects. Arrays and scalars from b replace those in a. */
export function deepMerge(a, b) {
  if (Array.isArray(b) || b === null || typeof b !== 'object') return b === undefined ? a : b;
  const out = a && typeof a === 'object' && !Array.isArray(a) ? { ...a } : {};
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(out[k], v);
  return out;
}

/** Convert a simple glob (**, *, ?) to a RegExp anchored on the whole relative path. */
export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const matchAny = (globs, rel) => (globs || []).some((g) => globToRegex(g).test(rel));

/** Literal directory prefix of a glob, used to estimate whether two tasks touch the same files. */
export function globPrefix(glob) {
  const i = glob.search(/[*?]/);
  return (i === -1 ? glob : glob.slice(0, i)).replace(/\/+$/, '');
}

export function globsOverlap(a, b) {
  for (const x of a) {
    for (const y of b) {
      const px = globPrefix(x);
      const py = globPrefix(y);
      if (px === py || px === '' || py === '' || px.startsWith(`${py}/`) || py.startsWith(`${px}/`)) return true;
    }
  }
  return false;
}

export const slug = (s, max = 40) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
