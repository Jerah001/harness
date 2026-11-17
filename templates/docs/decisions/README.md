# Decisions

One file per decision that later sessions must respect. Sessions do not remember each other;
this folder is how a choice outlives the session that made it.

Name the file after the task that made the decision, so parallel tasks never collide:
`T-012-use-sqlx-migrations.md`. The planner uses `P-<number>-<topic>.md`.

    # <Title>
    Status: accepted | superseded by <file>
    Task: T-012

    ## Context
    What forced a choice.

    ## Decision
    What we do, stated so that someone can follow it without reading the context.

    ## Consequences
    What this makes easy, what it rules out.
