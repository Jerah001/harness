# harness

An autonomous development harness for Claude Code. You write a PRD with acceptance criteria;
it plans the work as a task graph, runs one headless Claude Code session per task in its own
git worktree, lands only what passes deterministic gates, deploys to staging, and keeps going
until every `must` criterion passes there or it needs you.

The design, and the reasoning behind it, is in [docs/DESIGN.md](docs/DESIGN.md).

## Requirements

- Node.js 20 or newer, git, bash (macOS or Linux)
- Claude Code installed and signed in (`claude --version`); 2.1.259 or newer recommended
- For the default preset: pnpm and a Rust toolchain

There are no npm dependencies.

## Set up

Put the command on your PATH once:

```bash
cd ~/Desktop/projects/harness
npm link            # or: alias harness="node ~/Desktop/projects/harness/bin/harness.mjs"
npm test            # about 30 seconds, no Claude Code needed
```

Then, in the project you want built (an empty folder is fine):

```bash
mkdir ~/Desktop/projects/price-calculator && cd $_
harness init                      # preset: nextjs-rust-sqlite
$EDITOR docs/PRD.md               # write the product and its acceptance criteria
git add -A && git commit -m "chore: bootstrap harness"
harness doctor --live             # static checks, then two short real sessions (see below)
harness run
```

`harness init` installs:

```
CLAUDE.md                     rules every session reads; lessons section kept by the cleaner
.claude/agents/               planner, builder, reviewer, triager, cleaner
.claude/hooks/                guard.mjs, stop-gate.mjs, session-context.mjs
.claude/settings.json         permission rules and hook wiring
.harness/config.json          gates, verify steps, limits, worktree settings
docs/PRD.md                   yours to write
docs/ARCHITECTURE.md          the planner writes it
docs/CONTRACTS.md             layout and scripts the gates depend on
docs/decisions/               one file per decision
```

It merges into an existing `.claude/settings.json` and `CLAUDE.md` and never overwrites files
unless you pass `--force`.

## Writing the PRD

Acceptance criteria are what the loop converges on. One per line:

```markdown
- **AC-001** (must) A visitor can enter a product and quantity and see a total price.
- **AC-002** (must) A saved quote is still there after reloading the page.
- **AC-003** (should) The total updates without a page reload.
```

Each must be observable from outside and testable end to end. The loop is done when every
`must` passes in the e2e suite against staging.

## While it runs

```bash
harness status            # or open STATE.md
harness inbox             # questions from the agents
harness stop              # finish what is in flight, then stop
```

Ctrl+C stops immediately; uncommitted work in every worktree is committed to its task branch
first. `harness run` always continues from the saved state.

When it stops, `HANDOFF.md` says why and what to do:

```bash
harness answer Q-003 "use bankers rounding"
harness retry T-012 --guidance "the API already returns cents; do not convert twice"
harness cancel T-015
harness reopen I-004 --guidance "staging needs the migration to run first"
harness dismiss I-007     # an agent-reported issue that should not hold up the launch
harness replan "drop the export feature from the MVP"
harness approve plan      # only with humanGates.plan: true
```

## Configuration

Everything is in `.harness/config.json`. The parts you are most likely to change:

| Key | Default | Meaning |
|---|---|---|
| `limits.concurrency` | 2 | tasks built in parallel |
| `limits.maxAttemptsPerTask` | 4 | builder cycles before a task is blocked |
| `limits.maxCostUsd`, `maxRuns`, `maxHours` | 200, 300, 48 | hard ceilings for the whole run |
| `limits.cleanEveryMerges` | 6 | how often the cleaner runs |
| `claude.permissionMode` | `auto` | `acceptEdits` is stricter; `bypassPermissions` only in a container |
| `roles.<role>.model`, `.effort` | unset | per-role model and effort, e.g. a stronger model for planner and reviewer |
| `gates` | preset | commands; `quick: true` ones run after every session, all of them before a merge |
| `verify.steps` | preset | deploy to staging, then e2e against it |
| `humanGates.plan` | false | stop for plan approval before building |
| `worktrees.root` | `../{repo}.worktrees` | where task worktrees live |

The `nextjs-rust-sqlite` preset expects the layout and scripts in `docs/CONTRACTS.md`
(`web/`, `server/`, `e2e/`, `scripts/deploy-staging.sh`). The planner is told to build exactly
that in its first milestone. For another stack, start from `harness init --preset generic`
and fill in `gates` and `verify.steps`.

## Before the first real run: `harness doctor --live`

The orchestration is covered by tests that use a scripted stand-in for `claude`. What those
tests cannot show is how the Claude Code installed on your machine behaves. `harness doctor --live`
checks exactly that with two short sessions (under a minute, a few cents) in the project folder:

| It checks that | Because the loop depends on it for |
|---|---|
| every flag the loop passes is accepted | starting any session at all |
| the session returns a structured result | reading plans, verdicts and handoffs |
| the session id chosen by the harness is used, and `--resume` continues the conversation | threads: feedback to the same session, recovery after a crash |
| a plain command runs unattended in your permission mode | builds and tests inside sessions |
| the project's hooks run in headless mode, and the guard refuses a write to `.harness/` | the path guard and the inner gate loop |
| the agent definition is applied and `CLAUDE.md` is in context | each role's standing rules |

Each line is `ok`, `warn` (the loop works with less protection) or `FAIL` (fix before running),
with what to change. It writes only under `.harness/runtime/` and cleans up after itself.

## What to expect on a first real run

The harness has not been run end to end against real sessions yet, so treat the first project
as a shakedown:

- Run `harness doctor --live` first and fix anything it reports.
- Try it with `humanGates.plan: true` and `limits.maxCostUsd` set low, and read the plan.
- Run `harness run --max-runs 3` to watch the first sessions before letting it go.
- Session logs are in `.harness/runtime/logs/`; every transition is in `.harness/events.jsonl`.
- Staging needs credentials in your environment before `scripts/deploy-staging.sh` can work.
  Until a target is chosen, `docs/CONTRACTS.md` allows a local production build as staging.

## Repository layout

```
bin/harness.mjs        entry point
src/loop.mjs           the orchestrator: tick, lanes, transitions, recovery
src/graph.mjs          task graph, plan validation, scheduling, convergence rules (pure)
src/agents.mjs         how sessions are started and their results read
src/prompts.mjs        the brief each role receives
src/worktrees.mjs      worktree, branch and merge handling
src/gates.mjs          gates, verification, acceptance-criteria report parsing
src/render.mjs         STATE.md and HANDOFF.md
src/store.mjs          state file, lock, run registry
src/config.mjs         defaults and presets
src/live.mjs           the live wiring check behind `harness doctor --live`
src/init.mjs, cli.mjs  installation and commands
templates/             what `harness init` installs
test/                  end-to-end and unit tests with a fake `claude`
```
