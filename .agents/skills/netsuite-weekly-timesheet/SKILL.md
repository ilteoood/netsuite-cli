---

name: "netsuite-weekly-timesheet"
description: "Fill, update or submit the weekly NetSuite timesheet of the signed-in account with the netsuite-cli binary, and list or file vacations: \"fill my timesheet\", \"log my hours in NetSuite\", \"submit my timesheet\", \"timesheet for last week\", \"my hours are still empty\"."
version: 8
created: "2026-11-09"
updated: "2026-11-10"
---

## When to Use

Use when asked to fill, correct, check or submit the NetSuite weekly timesheet, or to list or file a vacation, for the account the CLI is signed in as. The tool is the `netsuite-cli` binary (`node bin/netsuite-cli.mjs` inside this repository). There is no schedule file anymore: project, task, hours, days and memo are flags of the command.

## Procedure

1. Dry-run the week first. `netsuite-cli timesheet fill --project <name> --task <name> --hours <hours> --dry-run` prints the plan and writes nothing; add `--week YYYY-MM-DD` (a Monday) for another week. `netsuite-cli projects list` prints the project names and ids.
2. Fill the week: the same command without `--dry-run`, with `--hours 8` (decimal or `8:00`), writes Monday to Friday. `--days mon,tue,wed` limits the days, `--memo` overrides the memo (default: the task name), `--activity` picks the service item (default `Solution Delivery`).
3. Add one row on a single day when the week is not a plain block: `netsuite-cli timesheet add --date YYYY-MM-DD --project <name> --task <name> --hours <hours>` (+ optional `--memo`, `--activity`). This is how an exception day gets its own project or task.
4. Submit only when the user asked, since it notifies the approver: `netsuite-cli timesheet fill ... --submit` fills and then submits the record. Nothing else submits.
5. Vacations: `netsuite-cli vacations list` prints the upcoming non-cancelled absences (type, start, end, status, days, id); file one with `netsuite-cli vacations create --start YYYY-MM-DD [--end YYYY-MM-DD] --type "Annual Leave" [--memo <text>] [--reference <text>]`, which prints `Created <reference> (id <id>)`.
6. The session flags are global and go before the resource: `netsuite-cli --cookie-file ~/cookie.txt timesheet fill ...`, `--login-url <url>`, `--json` for the raw report. Without a cookie the CLI opens Chrome on the login page and caches the session in `~/.cache/netsuite-cli/session.json`.

7. A stuck browser profile is cleared on its own: `netsuite-cli --clear` removes `~/.cache/netsuite-cli` (the shared Chrome profile and the cached session) and exits. It stands alone, takes no command, and the next run signs in again from scratch.

## Pitfalls

- Entries are matched by date + project + task. A fill only replaces the row with the same project and task id; a mismatched name appends a second row and doubles the day (80:00 instead of 40:00). Read the printed counts and total after every write.
- `timesheet fill` writes nothing while any entry would be replaced or removed: it fails with `Nothing was written. ... re-run with --force`. `--force` is required to replace existing hours. `timesheet add` has no `--force` and only touches its own date row.
- NetSuite refuses to change or delete entries of a submitted timesheet, and approved entries (`approvalstatus` 3) are refused before any write. Retract the timesheet in NetSuite first, then re-run with `--force`.
- NetSuite refuses to submit a timesheet when any entry of the week has no memo. A fill always writes one (default: the task name), a row added by hand may not.
- NetSuite pre-creates the weekly timesheet records, so `No timesheet exists for the week starting X` means the wrong Monday was passed, not that a record must be created. Weeks in a closed accounting period reject new entries.
- The session is a cached cookie that expires after roughly thirty idle minutes; the CLI opens the browser again when it detects that. Only one Chrome may run on the shared profile `~/.cache/netsuite-cli/browser-profile`, so close other runs or windows before retrying a "browser could not be started" error. When the profile itself is broken, `netsuite-cli --clear` removes it together with the cached session.
- Project, task and leave-type names are matched by substring (case- and whitespace-insensitive). An ambiguous one fails with `matches several ...`; use a longer fragment, or the id for `--activity`.

## Verification

1. `netsuite-cli timesheet fill --week <monday> --project <name> --task <name> --hours <hours> --dry-run` prints `Plan: 0 created, 0 replaced, 0 removed, 40:00 in the week of <monday>` once the week is correct; it reports the plan without writing.
2. A successful write prints `Wrote 5 created, 0 replaced, 0 removed, 40:00 in the week of <monday>`, ending in `, submitted` when `--submit` was used.
3. Re-running the dry-run after a fill must show no created, replaced or removed rows. Created rows on that second run mean the project or task name resolved to a different id than the existing entries.
4. On the NetSuite timesheet page every weekday shows the expected hours and every entry has a memo; the "Full Week Detail" summary only refreshes when the timesheet is submitted.
