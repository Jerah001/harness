// `harness doctor --live`. The scripted claude also plays the Claude Code runtime here: it runs
// the project's real hook scripts around each step, so these tests cover the hooks' trace output,
// the guard's refusal, and the report for each way the wiring can be broken.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { evaluateProbe } from '../src/live.mjs';
import { project } from './helpers.mjs';

const levels = (out) => Object.fromEntries(['ok', 'warn', 'FAIL'].map((l) => [l, out.split('\n').filter((line) => line.startsWith(`  ${l.padEnd(4)}  `)).length]));

test('doctor --live passes when flags, hooks, agent, permissions and resume all work, and leaves nothing behind', () => {
  const p = project({ plans: [] });
  try {
    const r = p.cliResult('doctor', '--live');
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(levels(r.out), { ok: 9, warn: 0, FAIL: 0 });
    for (const text of ['accepted the flags', 'structured result', 'session id chosen', 'commands run unattended in permission mode "auto"', 'hooks ran in the headless session (SessionStart, PreToolUse, Stop)', 'agent definition was applied (builder)', 'refused a write to .harness/', '--resume continued', 'CLAUDE.md was in the session context']) {
      assert.ok(r.out.includes(text), `missing: ${text}\n${r.out}`);
    }
    assert.match(r.out, /harness run --max-runs 3/);

    const [first, second] = p.calls();
    assert.equal(p.calls().length, 2);
    for (const flag of ['--session-id', '--agent', '--json-schema', '--permission-mode', '--permission-prompts', '--max-turns', '--max-budget-usd']) assert.ok(first.flags.includes(flag), flag);
    assert.ok(second.flags.includes('--resume') && !second.flags.includes('--session-id'));
    assert.equal(second.sessionId, first.sessionId);

    // what the hooks recorded: the guard let the command through and refused the protected write
    const trace = p.read('.harness/runtime/logs/doctor-live-trace.jsonl').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(trace.filter((t) => t.hook === 'guard').map((t) => [t.tool, t.decision, t.agent_type]), [['Bash', 'allow', 'builder'], ['Write', 'deny', 'builder']]);
    assert.ok(!fs.existsSync(path.join(p.root, '.harness/runtime/probe')));
    assert.equal(p.git('status', '--porcelain'), ''); // the check leaves the checkout clean
  } finally {
    p.cleanup();
  }
});

test('doctor --live reports sessions that come up without the project hooks, and removes what the unguarded write left', () => {
  const p = project({ plans: [], probe: { bare: true } });
  try {
    const r = p.cliResult('doctor', '--live');
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL {2}the project's hooks did not run in the headless session/);
    assert.match(r.out, /FAIL {2}a write to \.harness\/ was not refused/);
    assert.match(r.out, /bare mode/);
    assert.match(r.out, /Fix the FAIL lines/);
    assert.ok(!fs.existsSync(path.join(p.root, '.harness/runtime/probe')));
  } finally {
    p.cleanup();
  }
});

test('doctor --live shows what Claude Code printed when it rejects a flag, and does not try to resume', () => {
  const p = project({ plans: [], probe: { rejectFlag: '--permission-prompts' } });
  try {
    const r = p.cliResult('doctor', '--live');
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL {2}Claude Code did not complete a session with the flags the loop uses/);
    assert.match(r.out, /unknown option '--permission-prompts'/);
    assert.deepEqual(levels(r.out), { ok: 0, warn: 0, FAIL: 1 });
    assert.equal(p.calls().length, 1); // one attempt; nothing to resume
  } finally {
    p.cleanup();
  }
});

test('doctor --live tells apart blocked commands, a resume without memory, and the softer problems', () => {
  const p = project({ plans: [], probe: { denyCommand: true, forget: true, asText: true, noClaudeMd: true, agentSeen: 'general-purpose', modeSeen: 'default' } });
  try {
    const r = p.cliResult('doctor', '--live');
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL {2}a plain command did not run in permission mode "auto"/);
    assert.match(r.out, /acceptEdits/);
    assert.match(r.out, /FAIL {2}the resumed session did not have the earlier conversation/);
    assert.match(r.out, /warn {2}the result came back as text/);
    assert.match(r.out, /warn {2}the session ran as "general-purpose", not "builder"/);
    assert.match(r.out, /warn {2}the session ran in permission mode "default", not "auto"/);
    assert.match(r.out, /warn {2}could not confirm that CLAUDE\.md is loaded/);
    assert.match(r.out, /ok {4}the guard hook refused a write/); // still checked independently
  } finally {
    p.cleanup();
  }
});

test('evaluateProbe: a timeout is one clear finding; warnings alone do not fail the check', () => {
  const base = { mode: 'acceptEdits', agentName: 'builder', sessionId: 's', nonce: 'amber-1234' };
  const timedOut = evaluateProbe({ ...base, a: { timedOut: true }, b: null, trace: [], allowedOk: false, blockedExists: false });
  assert.deepEqual(timedOut.map((c) => c.level), ['fail']);

  const a = { structured: true, output: { rule_one: 'Evidence over belief.' }, sessionId: 's' };
  const b = { output: { remembered: 'The word was amber-1234.' } };
  const trace = [{ hook: 'guard', event: 'PreToolUse', tool: 'Write', decision: 'deny', permission_mode: 'acceptEdits' }];
  const noStop = evaluateProbe({ ...base, a, b, trace, allowedOk: true, blockedExists: false });
  assert.ok(!noStop.some((c) => c.level === 'fail'));
  assert.deepEqual(noStop.filter((c) => c.level === 'warn').map((c) => c.text), ['the Stop hook did not run', 'could not confirm that --agent builder was applied']);
});
