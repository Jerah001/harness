# Architecture — {{PROJECT}}

The planner writes this file before the first task starts and the cleaner keeps it in line with
the code. Builders read the parts that concern their task.

## System shape
_To be written by the planner: the pieces, how a request travels through them, where state lives._

## Data model
_Tables, keys, and the migrations approach._

## API contract
_Every route the web app calls: method, path, request, response, errors. Web and server tasks
build against this in parallel, so it has to be exact._

## How each acceptance criterion is tested
_For each AC id: the e2e scenario that proves it._

## Environments
_Local, per-worktree (ports and database path come from the environment), and staging._
