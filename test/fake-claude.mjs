#!/usr/bin/env node
// Stand-in for the `claude` CLI, used only by the tests. It accepts the flags the harness passes,
// acts out a scripted scenario (writes files, commits, returns structured output) and prints the
// same JSON envelope `claude -p --output-format json` prints.
//
//   FAKE_SCENARIO  path to a JSON file describing what each role does on each call
//   FAKE_STATE     directory for call counters and a log of every invocation
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('2.1.300 (Claude Code)');
  process.exit(0);
}
const arg = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const prompt = arg('-p') || '';
const resumed = argv.includes('--resume');
const sessionId = arg('--resume') || arg('--session-id');
const role = process.env.HARNESS_ROLE;
const taskId = process.env.HARNESS_TASK_ID || '';
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_SCENARIO, 'utf8'));
const stateDir = process.env.FAKE_STATE;
fs.mkdirSync(stateDir, { recursive: true });

const bump = (key) => {
  const f = path.join(stateDir, `${key}.count`);
  const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;
  fs.writeFileSync(f, String(n + 1));
  return n;
};
const pick = (list, n) => list[Math.min(n, list.length - 1)];
const sh = (cmd) => {
  try {
    execSync(cmd, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

fs.appendFileSync(
  path.join(stateDir, 'calls.jsonl'),
  `${JSON.stringify({ role, taskId, resumed, sessionId, agent: arg('--agent'), cwd: process.cwd(), flags: argv.filter((a) => a.startsWith('--')), prompt })}\n`,
);

// A resumed conversation reports its whole cost, like the real CLI.
const sessionCalls = bump(`session-${sessionId}`) + 1;
const emit = (structured, { asText = false } = {}) => {
  console.log(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: asText ? `Here is the result:\n\`\`\`json\n${JSON.stringify(structured)}\n\`\`\`` : 'done',
      session_id: sessionId,
      total_cost_usd: 0.5 * sessionCalls,
      num_turns: 7,
      ...(asText ? {} : { structured_output: structured }),
    }),
  );
  process.exit(0);
};

const writeFiles = (files = {}) => {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.resolve(rel)), { recursive: true });
    fs.writeFileSync(rel, content);
  }
};

if (role === 'planner') {
  const step = pick(scenario.plans, bump('planner'));
  writeFiles(step.write);
  emit(step.output);
}

if (role === 'builder' || role === 'cleaner') {
  const steps = scenario.tasks?.[taskId] || [{ write: { [`${taskId}.txt`]: 'ok\n' } }];
  const step = pick(steps, bump(`build-${taskId}`));
  if (step.fail === 'infra') {
    console.error('API Error: 401 authentication_failed');
    process.exit(1);
  }
  if (step.sleepMs) await new Promise((r) => setTimeout(r, step.sleepMs));
  if (step.mergeBase) sh('git merge main'); // leaves conflict markers; the files below resolve them
  writeFiles(step.write);
  if (step.commit !== false) {
    sh('git add -A');
    sh(`git commit -q --no-edit -m "${taskId}: scripted change"`) || sh(`git commit -q -m "${taskId}: scripted change"`);
  }
  emit(
    step.output || {
      status: 'done',
      summary: `Implemented ${taskId}.`,
      handoff: { done: [`wrote files for ${taskId}`], remaining: [], gotchas: [], next_step: 'none' },
      lessons: step.lessons || [],
      questions: step.questions || [],
      discovered_issues: step.discovered_issues || [],
    },
  );
}

if (role === 'reviewer') {
  const verdict = pick(scenario.reviews?.[taskId] || ['approve'], bump(`review-${taskId}`));
  if (verdict === 'approve') emit({ verdict: 'approve', summary: 'Does what the task asks.', findings: [{ severity: 'nit', file: 'x', issue: 'naming' }] });
  emit({
    verdict: 'request_changes',
    summary: 'Not there yet.',
    findings: [{ severity: 'major', file: 'b.txt', issue: 'does not meet the task', fix: 'make it right' }],
  });
}

if (role === 'triager') {
  const scripted = scenario.triage ? pick(scenario.triage, bump('triage')) : null;
  if (scripted) emit(scripted);
  const ids = [...new Set(prompt.match(/I-\d+/g) || [])];
  emit({
    summary: 'One fix per issue.',
    tasks: ids.map((id) => ({ title: `Fix ${id}`, description: `Resolve ${id}.`, area: 'web', fixes: [id], touches: [`fix-${id}/**`] })),
  });
}

// `harness doctor --live`. Here the fake also plays Claude Code's runtime: it runs the project's
// real hook scripts around each step, the way the CLI would, unless the scenario says the
// session came up without them ("bare").
if (role === 'probe') {
  const p = scenario.probe || {};
  if (p.rejectFlag && argv.includes(p.rejectFlag)) {
    console.error(`error: unknown option '${p.rejectFlag}'`);
    process.exit(1);
  }
  const fire = (script, input) => {
    if (p.bare) return { status: 0, stderr: '' };
    return spawnSync(process.execPath, [path.join('.claude', 'hooks', script)], {
      input: JSON.stringify({ session_id: sessionId, cwd: process.cwd(), permission_mode: p.modeSeen || arg('--permission-mode'), agent_type: p.agentSeen || arg('--agent') || undefined, ...input }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: process.cwd() },
      encoding: 'utf8',
    });
  };
  const memory = path.join(stateDir, `probe-word-${sessionId}`);
  if (resumed) {
    fire('session-context.mjs', { hook_event_name: 'SessionStart', source: 'resume' });
    const word = !p.forget && fs.existsSync(memory) ? fs.readFileSync(memory, 'utf8') : 'no idea';
    emit({ write_refused: false, refusal_message: '', rule_one: '', remembered: word });
  }
  fire('session-context.mjs', { hook_event_name: 'SessionStart', source: 'startup' });
  const command = prompt.match(/^\s*(node -e .*)$/m)?.[1];
  if (!p.denyCommand && fire('guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }).status === 0) sh(command);
  const target = path.resolve(prompt.match(/create `([^`]+)`/)[1]);
  const guard = fire('guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: target, content: 'x' } });
  const refused = guard.status === 2;
  if (!refused) fs.writeFileSync(target, 'x');
  fs.writeFileSync(memory, prompt.match(/next message: (\S+)/)[1]);
  fire('stop-gate.mjs', { hook_event_name: 'Stop', stop_hook_active: false });
  emit(
    { write_refused: refused, refusal_message: String(guard.stderr || '').slice(0, 200), rule_one: p.noClaudeMd ? 'unknown' : 'Evidence over belief. Work is done when its gate passes.', remembered: '' },
    { asText: !!p.asText },
  );
}

console.error(`fake-claude: no behaviour for role "${role}"`);
process.exit(1);
