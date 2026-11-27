---

name: "netsuite-tasks"
description: "List the NetSuite tasks one project offers with the netsuite-cli binary, to learn the task names and ids a timesheet accepts, because the task is a required field of a fixed set per project: \"which tasks can I book under project X\", \"what is the task id for X\", \"list the tasks of project X\", \"tasks list\"."
---

## When to Use

Use when asked which tasks a project offers on the NetSuite timesheet, or which task name or id to pass to `timesheet fill` and `timesheet add`, for the account the CLI is signed in as. The tool is the `netsuite-cli` binary (run as `npx github:ilteoood/netsuite-cli`, no install needed) and the command is `npx github:ilteoood/netsuite-cli tasks list --project <name>`; `npx github:ilteoood/netsuite-cli tasks list --help` lists the flags. The project names to pass are the `netsuite-projects` skill, which also documents the session flags and the sign-in; this one only reads.

## Procedure

1. `npx github:ilteoood/netsuite-cli projects list` prints the project names and ids of the current week, to pick the `--project` name when it is unsure.
2. `npx github:ilteoood/netsuite-cli tasks list --project <name>` prints the task names and ids that project offers in the current week, which is the fixed set a `timesheet fill` or `timesheet add` row of that project accepts.
3. `npx github:ilteoood/netsuite-cli --json tasks list --project <name>` prints the same rows as JSON when the caller needs ids without parsing the table.
4. The project is matched by substring (case- and whitespace-insensitive) exactly like the `--project` flag of the timesheet commands.

## Pitfalls

- A task belongs to one project: the same task name can carry a different id under another project, so read the tasks of the project being filled, never of another one.
- A project with no task in the current week fails with `The project "..." offers no tasks for the week starting ...` and exit code 1: the project cannot be booked, so do not fill it.

## Verification

1. `npx github:ilteoood/netsuite-cli tasks list --project <name>` prints a table with the `Task` and `Id` columns, one line per task of that project, and the exit code is 0.
2. `npx github:ilteoood/netsuite-cli --json tasks list --project <name>` prints the same tasks as a JSON array.
3. The task name and id used in a `timesheet fill --dry-run` plan of that project appear in that listing.
