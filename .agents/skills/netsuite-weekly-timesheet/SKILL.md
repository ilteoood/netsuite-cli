---

name: "netsuite-weekly-timesheet"
description: "Fill, update or submit the weekly NetSuite timesheet of the signed-in account with the netsuite-cli binary, and list or file vacations: \"fill my timesheet\", \"log my hours in NetSuite\", \"submit my timesheet\", \"timesheet for last week\", \"my hours are still empty\"."
---

## When to Use

Use when asked to fill, correct, check or submit the NetSuite weekly timesheet, or to list or file a vacation, for the account the CLI is signed in as. The tool is the `netsuite-cli` binary (`node bin/netsuite-cli.mjs` inside this repository). There is no schedule file: project, task, hours, days and memo are flags of the command. `netsuite-cli --help`, `netsuite-cli <resource> --help` and `netsuite-cli <resource> <verb> --help` list the resources, the verbs and the flags; `-h` does the same. The five verbs are `projects list`, `vacations list`, `vacations create`, `timesheet fill` and `timesheet add`.

## Procedure

1. Dry-run the week first. `netsuite-cli timesheet fill --project <name> --task <name> --hours <hours> --dry-run` prints the plan and writes nothing; add `--week YYYY-MM-DD` (a Monday) for another week. `netsuite-cli projects list` prints the project names and ids of the current week.
2. Fill the week: the same command without `--dry-run`, with `--hours 8` (decimal or `8:00`), writes Monday to Friday. `--days mon,tue,wed` fills only the named days and removes the other weekdays of that same project and task (see Pitfalls). `--memo` overrides the memo (default: the task name), `--activity` picks the service item by label or by id (default `Solution Delivery`, id 71).
3. Add one row on a single day when the week is not a plain block: `netsuite-cli timesheet add --date YYYY-MM-DD --project <name> --task <name> --hours <hours>` (+ optional `--memo`, `--activity`). This is how an exception day gets its own project or task, and it has no `--dry-run` and no `--force`.
4. Submit only when the user asked, since it notifies the approver: `netsuite-cli timesheet fill ... --submit` fills and then submits the record. Nothing else submits.
5. Vacations: `netsuite-cli vacations list` prints the upcoming non-cancelled absences whose end date is today or later (type, start, end, status, days, id), sorted by start. File one with `netsuite-cli vacations create --start YYYY-MM-DD [--end YYYY-MM-DD] --type "Annual Leave" [--memo <text>] [--reference <text>]`, which prints `Created <reference> (id <id>)` and creates the request with status `Approval Requested`. `--end` defaults to `--start` and `--reference` to the type and the dates.
6. The session flags are global and go before the resource: `netsuite-cli --cookie-file ~/cookie.txt timesheet fill ...`, `--login-url <url>`, `--json` for the raw result (a table or a sentence becomes JSON on every command). Without a cookie the CLI opens Chrome on the login page and caches the session in `~/.cache/netsuite-cli/session.json`. The account itself is only known from `--login-url` or from that cache, so a cookie alone is not enough on a machine that never signed in through the browser.
7. A stuck browser profile is cleared on its own: `netsuite-cli --clear` removes `~/.cache/netsuite-cli` (the shared Chrome profile and the cached session) and exits. It stands alone and takes no command. It prints `Removed <directory> and its contents (browser profile and cached session)`, or `Nothing to remove in <directory>`; with `--json` it prints `{"removed": …, "directory": …}`. Close every Chrome window before running it, and pass `--login-url` on the next command, because the cleared cache held the account; a machine that passes a cookie must leave the cookie out for that run.

## Pitfalls

- `--days` does not only limit the days it fills: the other weekdays of the same project and task are removed from the week. Narrowing a week that already holds those days therefore needs `--force`, and a five-day week narrowed to `mon,tue,wed` loses the hours of Thursday and Friday.
- Entries are matched by date + project + task. A fill only replaces the row with the same project and task id; a mismatched name appends a second row and doubles the day (80:00 instead of 40:00). Read the printed counts and total after every write.
- `timesheet fill` writes nothing while any entry would be replaced or removed: it fails with `Nothing was written. ... re-run with --force`. `--force` is required to replace existing hours. `timesheet add` has no `--force` and only touches the row of its date and pair.
- A dry-run reports the plan only: it returns before the submitted, approved, `--force` and memo checks, so `Plan: 0 created, 0 replaced, 0 removed` does not prove the week can be written.
- NetSuite refuses to change or delete entries of a submitted timesheet (`Timesheet <id> is already submitted. Retract it in NetSuite before filling it again.`), and approved entries (`approvalstatus` 3) are refused before any write. Retract the timesheet in NetSuite first, then re-run with `--force`.
- NetSuite refuses to submit a timesheet when any entry of the week has no memo, and the CLI checks that before writing. A fill always writes one (default: the task name), a row added by hand may not.
- NetSuite pre-creates the weekly timesheet records, so `No timesheet exists for the week starting X` means the wrong Monday was passed, not that a record must be created. Weeks in a closed accounting period reject new entries. `projects list` reads the record of the current week and fails the same way when that week is missing.
- Two existing rows for one project and task on one day abort every run, dry-run included: `Timesheet <week> already holds two entries for <project id> on <date>. Fix them in NetSuite before filling it again.`
- The session is a cached cookie that expires after roughly thirty idle minutes; every run probes it and the CLI signs in again through the browser when it has expired. Only one Chrome may run on the shared profile `~/.cache/netsuite-cli/browser-profile`, so close other runs or windows before retrying a `The browser could not be started` error. When the profile itself is broken, close every Chrome window and run `netsuite-cli --clear`, which removes the profile together with the cached session; the next command needs `--login-url` again, since the account lived in that cache.
- `--clear` cannot be combined with a command (`"--clear" cannot be combined with a command`), and it is unknown between a resource and its verb; it needs no session, so an expired cookie does not block it.
- Project, task, activity and leave-type names are matched by substring (case- and whitespace-insensitive). An ambiguous one fails with `matches several ...`; use a longer fragment, or the id for `--activity`. An unknown project or task fails with `No ... matches "...". Closest: ...`.
- `vacations create` is a real approval request: it rejects an end date before the start (`The end date ... is before the start date ...`) and a range that overlaps any existing non-cancelled absence (`... overlaps ... (id ...)`).
- Errors go to stderr as `netsuite-cli: ...`. A usage error exits 1, a NetSuite or session failure exits 2.

## Verification

1. `netsuite-cli timesheet fill --week <monday> --project <name> --task <name> --hours <hours> --dry-run` prints `Plan: 0 created, 0 replaced, 0 removed, 40:00 in the week of <monday>` once the week is correct; it reports the plan without writing.
2. A successful write prints `Wrote 5 created, 0 replaced, 0 removed, 40:00 in the week of <monday>`, ending in `, submitted` when `--submit` was used. `timesheet add` prints the same line with the total of the whole week.
3. Re-running the dry-run after a fill must show no created, replaced or removed rows. Created rows on that second run mean the project or task name resolved to a different id than the existing entries.
4. `netsuite-cli vacations list` shows a filed vacation with status `Approval Requested` and the expected dates.
5. On the NetSuite timesheet page every weekday shows the expected hours and every entry has a memo; the "Full Week Detail" summary only refreshes when the timesheet is submitted.
