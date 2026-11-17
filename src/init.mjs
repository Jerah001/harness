// `harness init`: install the harness files into a project.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_DIR, buildConfig, configPath } from './config.mjs';
import { git, readJson, writeJson } from './util.mjs';

const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));

const IGNORE = [
  '# harness: generated state (rendered from .harness/state.json, never committed)',
  '.harness/state.json',
  '.harness/events.jsonl',
  '.harness/runtime/',
  'STATE.md',
  'HANDOFF.md',
];

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

/** Add our permission rules and hooks to an existing settings file without dropping what is there. */
function mergeSettings(existing, ours) {
  const out = { ...existing };
  out.permissions = { ...(existing.permissions || {}) };
  for (const key of ['allow', 'deny', 'ask']) {
    const merged = [...new Set([...(existing.permissions?.[key] || []), ...(ours.permissions?.[key] || [])])];
    if (merged.length) out.permissions[key] = merged;
  }
  out.hooks = { ...(existing.hooks || {}) };
  for (const [event, groups] of Object.entries(ours.hooks || {})) {
    const have = new Set((out.hooks[event] || []).flatMap((g) => (g.hooks || []).map((h) => h.command)));
    out.hooks[event] = [...(out.hooks[event] || []), ...groups.filter((g) => !g.hooks.every((h) => have.has(h.command)))];
  }
  return out;
}

export function init(root, { preset = 'nextjs-rust-sqlite', force = false } = {}) {
  const done = [];
  const skipped = [];
  const write = (rel, content, { overwrite = force } = {}) => {
    const dest = path.join(root, rel);
    if (fs.existsSync(dest) && !overwrite) {
      skipped.push(rel);
      return false;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    done.push(rel);
    return true;
  };

  // git
  if (git(['rev-parse', '--show-toplevel'], root, { allowFail: true }).code !== 0) {
    git(['init', '-q', '-b', 'main'], root);
    done.push('(git init -b main)');
  }
  const branch = git(['symbolic-ref', '--short', 'HEAD'], root, { allowFail: true }).out || 'main';

  // config
  const cfg = buildConfig(preset, { project: { name: path.basename(root), baseBranch: branch } });
  if (!fs.existsSync(configPath(root)) || force) {
    writeJson(configPath(root), cfg);
    done.push(`${HARNESS_DIR}/config.json`);
  } else skipped.push(`${HARNESS_DIR}/config.json`);

  // templates: templates/claude/** -> .claude/**, everything else to the same relative path
  for (const rel of walk(TEMPLATES)) {
    const src = path.join(TEMPLATES, rel);
    const text = fs.readFileSync(src, 'utf8');
    if (rel === 'gitignore') continue;
    const destRel = rel.startsWith(`claude${path.sep}`) ? `.${rel}` : rel;
    if (destRel === path.join('.claude', 'settings.json') && fs.existsSync(path.join(root, destRel)) && !force) {
      writeJson(path.join(root, destRel), mergeSettings(readJson(path.join(root, destRel)), JSON.parse(text)));
      done.push(`${destRel} (merged)`);
      continue;
    }
    if (destRel === 'CLAUDE.md' && fs.existsSync(path.join(root, destRel)) && !force) {
      const cur = fs.readFileSync(path.join(root, destRel), 'utf8');
      if (cur.includes('harness:rules:start')) skipped.push(destRel);
      else {
        const block = text.slice(text.indexOf('<!-- harness:rules:start -->'));
        fs.writeFileSync(path.join(root, destRel), `${cur.trimEnd()}\n\n${block}`);
        done.push(`${destRel} (harness section appended)`);
      }
      continue;
    }
    write(destRel, text.replaceAll('{{PROJECT}}', path.basename(root)));
  }

  // .gitignore
  const giFile = path.join(root, '.gitignore');
  const gi = fs.existsSync(giFile) ? fs.readFileSync(giFile, 'utf8') : '';
  const missing = IGNORE.filter((l) => !gi.split('\n').includes(l));
  if (missing.length) {
    fs.writeFileSync(giFile, `${gi.trimEnd()}${gi.trim() ? '\n\n' : ''}${missing.join('\n')}\n`);
    done.push('.gitignore');
  }
  return { done, skipped, preset, branch };
}
