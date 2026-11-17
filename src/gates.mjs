// Deterministic checks. Agents never decide whether work is done; these commands do.
import fs from 'node:fs';
import path from 'node:path';
import { sh, tail } from './util.mjs';

/** Gates in a set. "quick" is filtered by the task's area; "full" is every gate. */
export function selectGates(cfg, { set, area, cwd }) {
  return cfg.gates
    .filter((g) => set === 'full' || (g.quick && (!g.areas || !area || g.areas.includes(area))))
    .map((g) => ({ ...g, skip: !!g.if && !fs.existsSync(path.join(cwd, g.if)) }));
}

/** True when the full set checks nothing beyond what an unfiltered quick run already did. */
export const fullAddsNothing = (cfg) => !cfg.gates.some((g) => !g.quick || g.areas);

export function runGates(cfg, { set = 'quick', area, cwd, env, logDir, onStep }) {
  const failFast = set === 'full'; // quick runs report every failure at once so one session can fix them all
  const results = [];
  for (const g of selectGates(cfg, { set, area, cwd })) {
    if (g.skip) {
      results.push({ name: g.name, ok: true, skipped: true });
      continue;
    }
    onStep?.(g.name);
    const t0 = Date.now();
    const r = sh(g.cmd, { cwd, env, timeoutMs: (g.timeoutMin || cfg.limits.gateTimeoutMin) * 60000 });
    if (logDir) {
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, `${g.name.replace(/[^\w.-]+/g, '_')}.log`), r.out);
    }
    const ok = r.code === 0;
    results.push({
      name: g.name,
      cmd: g.cmd,
      ok,
      code: r.code,
      ms: Date.now() - t0,
      timedOut: r.timedOut || undefined,
      tail: ok ? undefined : tail(r.out, 60, 5000),
    });
    if (!ok && failFast) break;
  }
  return { ok: results.every((r) => r.ok), set, results };
}

/** Text handed back to the builder when a gate fails. */
export function gateFailureText(g, fallback = '') {
  if (!g?.results) return fallback || 'The gate runner produced no result.';
  return g.results
    .filter((r) => !r.ok)
    .map((r) => `### ${r.name} failed (exit ${r.code}${r.timedOut ? ', timed out' : ''})\n$ ${r.cmd}\n${r.tail || ''}`)
    .join('\n\n');
}

/**
 * Project-level verification on the base branch: deploy to staging, then run the e2e suite
 * against it. The acceptance-criteria report is read even when the e2e step fails, because a
 * failing suite still says which criteria pass.
 */
export function runVerify(cfg, { cwd, env, logDir, onStep }) {
  const reportCfg = cfg.verify.acReport;
  const reportFile = reportCfg?.path ? path.join(cwd, reportCfg.path) : null;
  if (reportFile) fs.rmSync(reportFile, { force: true }); // never read a stale report
  const captured = {};
  const steps = [];
  for (const s of cfg.verify.steps) {
    if (s.if && !fs.existsSync(path.join(cwd, s.if))) {
      steps.push({ name: s.name, ok: true, skipped: true });
      continue;
    }
    if (s.requires && !fs.existsSync(path.join(cwd, s.requires))) {
      steps.push({ name: s.name, ok: false, code: 127, acReport: !!s.acReport, tail: `Missing ${s.requires}. docs/CONTRACTS.md describes what it must do.` });
      break;
    }
    onStep?.(s.name);
    const t0 = Date.now();
    const r = sh(s.cmd, { cwd, env: { ...env, ...captured }, timeoutMs: (s.timeoutMin || cfg.limits.gateTimeoutMin) * 60000 });
    if (logDir) {
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, `verify-${s.name.replace(/[^\w.-]+/g, '_')}.log`), r.out);
    }
    const missing = [];
    for (const [key, re] of Object.entries(s.capture || {})) {
      const m = r.out.match(new RegExp(re));
      if (m) captured[key] = m[1];
      else missing.push(key);
    }
    const ok = r.code === 0 && missing.length === 0;
    steps.push({
      name: s.name,
      cmd: s.cmd,
      ok,
      code: r.code,
      ms: Date.now() - t0,
      acReport: !!s.acReport,
      tail: ok ? undefined : `${missing.length ? `The output did not contain ${missing.join(', ')}.\n` : ''}${tail(r.out, 60, 5000)}`,
    });
    if (!ok) break;
  }
  let acs = null;
  if (reportFile && fs.existsSync(reportFile)) {
    try {
      acs = parseAcReport(reportFile, reportCfg.format);
    } catch (err) {
      steps.push({ name: 'ac-report', ok: false, code: 1, tail: `Cannot parse ${reportCfg.path}: ${err.message}` });
    }
  }
  return { ok: steps.every((s) => s.ok), steps, captured, acs };
}

/**
 * Map test results to acceptance criteria by the AC ids in test titles.
 * A criterion passes when at least one test mentioning it ran and passed, and none failed.
 * Skipped tests never count as a pass.
 */
export function parseAcReport(file, format = 'playwright-json') {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const seen = {};
  const note = (title, ok) => {
    for (const ac of new Set(String(title).match(/\bAC-\d+\b/g) || [])) {
      seen[ac] ??= { pass: 0, fail: 0 };
      if (ok) seen[ac].pass += 1;
      else seen[ac].fail += 1;
    }
  };
  if (format === 'playwright-json') {
    const walk = (suite, trail) => {
      const here = [...trail, suite.title || ''];
      for (const spec of suite.specs || []) {
        const statuses = (spec.tests || []).map((t) => t.status);
        const ran = statuses.length ? statuses.some((s) => s === 'expected' || s === 'flaky') : true;
        note([...here, spec.title].join(' › '), spec.ok === true && ran);
      }
      for (const child of suite.suites || []) walk(child, here);
    };
    for (const s of data.suites || []) walk(s, []);
  } else if (format === 'map') {
    // { "AC-001": true | "pass" | "fail" } — for stacks without Playwright
    for (const [key, v] of Object.entries(data)) note(key, v === true || v === 'pass' || v === 'passed');
  } else {
    throw new Error(`unknown acReport.format "${format}"`);
  }
  const out = {};
  for (const [ac, c] of Object.entries(seen)) out[ac] = c.fail === 0 && c.pass > 0 ? 'pass' : 'fail';
  return out;
}
