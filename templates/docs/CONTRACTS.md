# Contracts between the project and the harness

The harness checks work by running commands, never by asking an agent whether it is done.
For that to work the project keeps the layout and scripts below stable. They match the
`nextjs-rust-sqlite` preset in `.harness/config.json`; if you change one side, change the other.

## Layout

    web/        Next.js app (TypeScript, App Router), managed with pnpm
    server/     Rust API (Cargo project) using SQLite
    e2e/        Playwright tests that drive the real web app against the real server
    scripts/    dev.sh, deploy-staging.sh, and other entry points
    deploy/     whatever staging needs (Dockerfiles, compose file, platform config)
    docs/       PRD.md, ARCHITECTURE.md, this file, decisions/

A `pnpm-workspace.yaml` at the root lists `web` and `e2e`.

## Scripts each package must provide

`web/package.json`
- `lint` — ESLint, zero warnings allowed
- `typecheck` — `tsc --noEmit`
- `test` — unit tests, non-interactive (for Vitest: `vitest run`)
- `build` — production build

`server/` must pass
- `cargo fmt --all -- --check`
- `cargo clippy --all-targets -- -D warnings`
- `cargo test`
- `cargo build --release`

`e2e/package.json`
- `test:local` — starts web and server itself (Playwright `webServer`) and runs the suite
- `test:staging` — runs the same suite against the URL in `STAGING_URL`, starting nothing
- Both write a Playwright JSON report to `e2e/report.json` (reporter: `['json', { outputFile: 'report.json' }]`).

## Environment

Several worktrees build and test at the same time. Nothing may assume a fixed port or a fixed
database file. Read these, with the defaults shown for a plain local run:

| Variable | Meaning | Default |
|---|---|---|
| `WEB_PORT` | port for the Next.js server | 3000 |
| `API_PORT` | port for the Rust server | 8080 |
| `DATABASE_URL` | SQLite location | `sqlite://data/dev.db` |
| `STAGING_URL` | base URL for `test:staging` | none |

The Playwright config derives its base URL and `webServer` commands from `WEB_PORT` and `API_PORT`.

## Acceptance criteria and tests

- Every criterion in `docs/PRD.md` has at least one e2e test whose title, or the title of the
  `describe` block around it, contains the criterion id: `test('AC-003: a saved quote appears in the list', …)`.
- A criterion counts as passing when at least one test that mentions it ran and passed and none
  that mention it failed. Skipped tests do not count.
- The harness reads `e2e/report.json` after `test:staging`. That report is the definition of done.

## Staging deploy

`scripts/deploy-staging.sh`
- builds and deploys the current checkout to the staging environment, non-interactively;
- waits until the deployment is healthy before it exits;
- prints a line `STAGING_URL=https://…` to stdout;
- exits non-zero on any failure;
- takes credentials from the environment only (never from files in the repository).

If no cloud target has been chosen yet, a production build run with Docker Compose on this
machine is an acceptable staging environment: it exercises the same build and the same e2e
suite. Moving to a real host later only changes this script.

## Files that must be gitignored

`node_modules/`, `.next/`, `target/`, `data/`, `e2e/report.json`, `e2e/test-results/`,
`playwright-report/`, `.env`, `.env.local`. The main checkout has to stay clean while the loop
runs; build output that shows up as a change gets stashed by the orchestrator.

## Production

Not part of the loop. The loop stops when staging is verified; releasing to production is a
human decision.
