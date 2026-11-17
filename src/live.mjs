// `harness doctor --live`: two short real sessions that prove the installed Claude Code behaves
// the way the loop assumes. The tests in test/ use a scripted stand-in for `claude`, so this is
// the check that the real one accepts the same flags, loads the project's hooks and agent
// definitions in headless mode, can run commands unattended, and resumes a conversation.
//
// It writes nothing outside .harness/runtime/ and costs a few cents.
import fs from 'node:fs';
import path from 'node:path';
import { startAgent } from './agents.mjs';
import { tail, uuid } from './util.mjs';

const PROBE_SCHEMA = {
  type: 'object',
  required: ['write_refused', 'remembered'],
  properties: {
    write_refused: { type: 'boolean' },
    refusal_message: { type: 'string' },
    rule_one: { type: 'string' },
    remembered: { type: 'string' },
  },
};

const REL = '.harness/runtime/probe';

const firstPrompt = (nonce) => `# Wiring check

\`harness doctor --live\` started this session to check its own setup. It is not a development
task: ignore any standing instruction to implement, test or commit something. Do exactly these
steps, once each, and nothing else.

1. Run this shell command exactly as written:
   node -e "require('fs').writeFileSync('${REL}/allowed.txt','42')"
2. Use the Write tool to create \`${REL}/blocked.txt\` containing \`x\`. A hook is expected to
   refuse it. Do not retry and do not create the file any other way.
3. Keep this word in mind for the next message: ${nonce}

Then return the result object:
- write_refused: true if step 2 was refused, false if the file was written
- refusal_message: the refusal text you were shown, at most 200 characters ("" if none)
- rule_one: the first rule under "Rules that always apply" in this project's CLAUDE.md, but only
  if CLAUDE.md is already in your context. If it is not, answer "unknown". Do not open any file
  to find it.
- remembered: ""`;

const secondPrompt = `Wiring check, part two. Do not use any tools. Return the result object with \`remembered\` set
to the word from step 3 of my previous message, \`write_refused\` false, and the other fields "".`;

const indent = (text, n = 8) =>
  String(text || '')
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n');

/**
 * Turn what the two sessions did into a list of findings. Pure, so it can be tested.
 * level: ok | warn (the loop still works, with less protection) | fail (fix before `harness run`)
 */
export function evaluateProbe({ mode, agentName, sessionId, nonce, a, b, trace, allowedOk, blockedExists }) {
  const out = [];
  const add = (level, text, fix) => out.push({ level, text, fix });

  if (a.infra || a.timedOut) {
    add(
      'fail',
      a.timedOut ? 'the first session did not finish in time' : 'Claude Code did not complete a session with the flags the loop uses',
      `${a.text ? `What it printed:\n${indent(tail(a.text, 12, 1500), 2)}\n` : ''}If a flag is reported as unknown, update Claude Code. If it is a sign-in or usage-limit message, fix that first; the loop would stop on the same error.`,
    );
    return out; // nothing else can be judged
  }
  add('ok', 'Claude Code accepted the flags the loop uses');

  if (a.structured) add('ok', 'the session returned a structured result (--json-schema)');
  else if (a.output) add('warn', 'the result came back as text, not as structured_output', 'The loop falls back to reading JSON out of the reply, which is less reliable. Update Claude Code if sessions end without a result.');
  else add('fail', 'the session returned no result object', `Every role must end with one. What it said:\n${indent(tail(a.text, 8, 800), 2)}`);

  if (a.sessionId === sessionId) add('ok', 'the session id chosen by the harness was used (--session-id)');
  else add('fail', `--session-id was not honoured (got ${a.sessionId || 'none'})`, 'Threads could not be resumed after a crash or for feedback.');

  if (allowedOk) add('ok', `commands run unattended in permission mode "${mode}"`);
  else {
    add(
      'fail',
      `a plain command did not run in permission mode "${mode}"${a.denials ? ` (${a.denials} permission denial${a.denials === 1 ? '' : 's'} reported)` : ''}`,
      'Loop sessions could not run builds or tests. If auto mode is not available for your account or model, set claude.permissionMode to "acceptEdits" in .harness/config.json (the allow rules in .claude/settings.json then decide), or run the loop in a container with "bypassPermissions".',
    );
  }

  const events = [...new Set(trace.map((t) => t.event).filter(Boolean))];
  if (!trace.length) {
    add(
      'fail',
      "the project's hooks did not run in the headless session",
      'Without them there is no path guard and no inner gate loop (the orchestrator still gates every branch and restores protected paths). Check that .claude/settings.json is valid and that hooks are not disabled; if this Claude Code version runs `-p` in bare mode by default, the session flags in src/agents.mjs need updating.',
    );
  } else {
    add('ok', `hooks ran in the headless session (${events.join(', ')})`);
    if (!events.includes('Stop')) add('warn', 'the Stop hook did not run', 'Gate failures will not be handed back inside a session. The orchestrator runs the same gate afterwards, so nothing unverified lands; sessions just take more rounds.');

    const agentSeen = trace.map((t) => t.agent_type).find(Boolean);
    if (agentSeen === agentName) add('ok', `the agent definition was applied (${agentName})`);
    else add('warn', agentSeen ? `the session ran as "${agentSeen}", not "${agentName}"` : `could not confirm that --agent ${agentName} was applied`, `Check that .claude/agents/${agentName}.md exists and is committed. Without it a session gets the brief but not the role's standing rules.`);

    const modeSeen = trace.map((t) => t.permission_mode).find(Boolean);
    const same = modeSeen === mode || (mode === 'manual' && modeSeen === 'default');
    if (modeSeen && !same) add('warn', `the session ran in permission mode "${modeSeen}", not "${mode}"`, 'The requested mode may be unavailable or disabled for this account. Set claude.permissionMode to one that is.');
  }

  const refused = trace.some((t) => t.hook === 'guard' && t.decision === 'deny');
  if (blockedExists) add('fail', 'a write to .harness/ was not refused', 'The guard hook is the first line of defence for harness-owned files. The orchestrator restores protected paths after each session, so nothing would land, but check the PreToolUse entry in .claude/settings.json.');
  else if (refused) add('ok', 'the guard hook refused a write to .harness/');
  else if (trace.length) add('warn', 'the session did not attempt the protected write, so the guard was not exercised', 'Run the check again.');

  if (!b) add('warn', 'the resume step was skipped');
  else if (b.infra || b.timedOut) add('fail', '--resume did not work', `Feedback could not go back to the session that wrote the code.${b.text ? ` What it printed:\n${indent(tail(b.text, 8, 800), 2)}` : ''}`);
  else if (String(b.output?.remembered || '').includes(nonce)) add('ok', '--resume continued the same conversation');
  else add('fail', 'the resumed session did not have the earlier conversation', `It answered "${String(b.output?.remembered || '').slice(0, 60)}". Set limits.maxResumesPerSession to 0 so every round starts a fresh session with a handoff.`);

  const rule = String(a.output?.rule_one || '');
  if (/evidence/i.test(rule)) add('ok', 'CLAUDE.md was in the session context');
  else add('warn', `could not confirm that CLAUDE.md is loaded in headless sessions (the session answered "${rule.slice(0, 60) || '…'}")`, 'Expected if you rewrote the rules section. Otherwise sessions miss the project rules; the brief and the agent definition still apply.');

  return out;
}

export async function liveCheck(H, caps) {
  const { cfg, root } = H;
  const dir = path.join(root, REL);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const traceFile = path.join(dir, 'trace.jsonl');
  const allowed = path.join(dir, 'allowed.txt');
  const blocked = path.join(dir, 'blocked.txt');

  // Same flags as a builder session, with small ceilings. The role name "probe" keeps the Stop
  // hook from running the real gates.
  const b0 = cfg.roles.builder;
  const probeH = { ...H, cfg: { ...cfg, roles: { ...cfg.roles, probe: { ...b0, maxTurns: 12, maxBudgetUsd: 1, timeoutMin: 5 } } } };
  const sessionId = uuid();
  const nonce = `${['amber', 'birch', 'cedar', 'delta', 'ember', 'flint'][Math.floor(Math.random() * 6)]}-${1000 + Math.floor(Math.random() * 9000)}`;
  const session = (prompt, resume, runId) =>
    startAgent(probeH, caps, { role: 'probe', prompt, cwd: root, env: { HARNESS_PROBE: traceFile }, sessionId, resume, schema: PROBE_SCHEMA, runId, name: 'harness wiring check' }).done;

  const a = await session(firstPrompt(nonce), false, 'doctor-live-1');
  const b = a.infra || a.timedOut ? null : await session(secondPrompt, true, 'doctor-live-2');

  const trace = fs.existsSync(traceFile)
    ? fs
        .readFileSync(traceFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return {};
          }
        })
    : [];
  const allowedOk = fs.existsSync(allowed) && fs.readFileSync(allowed, 'utf8').trim() === '42';
  const blockedExists = fs.existsSync(blocked);
  const checks = evaluateProbe({ mode: cfg.claude.permissionMode, agentName: b0.agent, sessionId, nonce, a, b, trace, allowedOk, blockedExists });

  if (trace.length) fs.copyFileSync(traceFile, H.logFile('doctor-live-trace.jsonl'));
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    checks,
    ok: !checks.some((c) => c.level === 'fail'),
    costUsd: Math.max(a.costTotal || 0, b?.costTotal || 0),
    logs: [H.logFile('doctor-live-1-probe.log'), H.logFile('doctor-live-2-probe.log')],
  };
}

export function formatChecks(checks) {
  const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  return checks.map((c) => `  ${mark[c.level]}  ${c.text}${c.fix && c.level !== 'ok' ? `\n${indent(c.fix)}` : ''}`).join('\n');
}
