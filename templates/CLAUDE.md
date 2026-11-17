# {{PROJECT}}

<!-- harness:rules:start -->
This repository is built by an autonomous harness: an orchestrator script plans the work as a
task graph, runs one Claude Code session per task in its own git worktree, and only lands work
that passes deterministic gates. This file is the part every session reads. Keep it short.

## Orient yourself
- `STATE.md` — where the project is right now. Generated; never edit it.
- `HANDOFF.md` — what the next person or session should do. Generated; never edit it.
- `docs/PRD.md` — what we are building, with the acceptance criteria. Owned by the human.
- `docs/ARCHITECTURE.md` — how it is built. Owned by the planner.
- `docs/CONTRACTS.md` — the folder layout and commands the harness depends on.
- `docs/decisions/` — one file per decision that later sessions must respect.

## Rules that always apply
1. Evidence over belief. Work is done when its gate passes, not when it looks right.
2. Every acceptance criterion has an e2e test whose title contains its id, for example `AC-007: …`.
3. Never weaken a check to get past it: no skipped or deleted tests, loosened assertions,
   lint or type suppressions, unless the task explicitly asks for that.
4. Stay inside your task. A problem you notice elsewhere goes into `discovered_issues` in your
   result, not into your diff.
5. Do not edit `.harness/`, `.claude/`, `STATE.md`, `HANDOFF.md` or `docs/PRD.md`.
6. A choice that constrains future work gets a file in `docs/decisions/` (name it after your task id).
7. Commit small and often on your task branch. Never push, rebase, or switch branches; the
   orchestrator merges.
8. No session remembers the previous one. Whatever the next session needs goes in your result's
   `handoff`, in the code, or in `docs/`.

## Stack and layout
Next.js (TypeScript) in `web/`, Rust API in `server/`, SQLite, Playwright in `e2e/`.
The exact scripts each package must expose are in `docs/CONTRACTS.md`.

## Check your work
- `harness gate` — the quick gate for the current folder (lint, types, unit tests).
- `harness gate --set full` — everything, including builds and local e2e.
- `harness status` — the same content as `STATE.md`, regenerated.
<!-- harness:rules:end -->

<!-- harness:lessons:start -->
## Lessons learned
The cleaner agent maintains this section from lessons reported by other sessions.
Keep it under 40 lines; delete what is no longer true.

- (none yet)
<!-- harness:lessons:end -->
