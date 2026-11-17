# Product requirements — {{PROJECT}}

This file is yours. The harness reads it, never writes it. Everything the loop builds traces
back to an acceptance criterion below; anything not listed here does not get built.

## Problem
Who has the problem, what it costs them today, and why now. Three or four sentences.

## Users
- Primary user: …
- Secondary user: …

## What the MVP does
The few things a user can do end to end when this ships. Plain sentences.

## What it does not do
Everything tempting that is out of scope for the MVP. Be explicit: the planner treats this list
as a boundary.

## Acceptance criteria
One line per criterion, each observable from outside the system and testable end to end.
The format matters, because the harness parses it:

    - **AC-NNN** (must|should|could) What a user can do or observe.

Replace NNN with a number (AC-001, AC-002, …). The loop stops when every `must` criterion
passes in the e2e suite against staging. `should` criteria are built if a task covers them but
never hold up the launch. `could` criteria are recorded for later.

<!-- Write your criteria below this line. -->


## Constraints
- Stack: Next.js (TypeScript) web app, Rust API server, SQLite. See docs/CONTRACTS.md.
- Staging target: … (for example: one small VM with Docker Compose, or Fly.io)
- Anything else that is fixed: browsers, languages, data that must not leave a region, budget.

## Open questions
Things you have not decided. The planner picks the simplest option for each and records it in
docs/decisions/; answer here first if you care which way it goes.
