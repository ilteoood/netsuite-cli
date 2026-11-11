---

name: "netsuite-vacations"
description: "List and file vacations of the signed-in NetSuite account with the netsuite-cli binary: \"file a vacation\", \"request annual leave\", \"book next week off in NetSuite\", \"what vacations do I have left\", \"list my absences\", \"cancel my vacation request\"."
---

## When to Use

Use when asked to list the upcoming NetSuite absences or to file a leave request, for the account the CLI is signed in as. The tool is the `netsuite-cli` binary (`node bin/netsuite-cli.mjs` inside this repository). The two verbs are `vacations list` and `vacations create`; `netsuite-cli vacations list --help` and `netsuite-cli vacations create --help` list the flags.

## Procedure

1. `netsuite-cli vacations list` prints the upcoming non-cancelled absences whose end date is today or later (type, start, end, status, days, id), sorted by start.
2. File one with `netsuite-cli vacations create --start YYYY-MM-DD [--end YYYY-MM-DD] --type "Annual Leave" [--memo <text>] [--reference <text>]`, which prints `Created <reference> (id <id>)`. `--end` defaults to `--start` and `--reference` to the type and the dates. The leave type is matched case-insensitively by substring against `Annual Leave`, `Bank Holiday`, `Training`, `Event Leave` and `Other Leave`.
3. File it only when the user asked: it is a real approval request, created with status `Approval Requested`, and it notifies the approver. The CLI cannot edit or cancel a request afterwards; that happens in NetSuite.
4. The session flags are global and go before the resource: `netsuite-cli --cookie-file ~/cookie.txt vacations list`, `--json` for the raw result (a table or a sentence becomes JSON on every command). Without a cookie the CLI opens Chrome on the NetSuite sign-in page and caches the session in `~/.cache/netsuite-cli/session.json`. The account itself is only known from that cache or from `netsuite-cli login <url>`, which signs in on the pasted NetSuite sign-in page and stores it for the later sign-ins, so a cookie alone is not enough on a machine that never signed in through the browser.
5. A stuck browser profile is cleared on its own: `netsuite-cli --clear` removes `~/.cache/netsuite-cli` (the shared Chrome profile, the cached session and the stored login page) and exits. It stands alone and takes no command. Close every Chrome window before running it, and run `netsuite-cli login <url>` again afterwards, because the cleared cache held the account and the page; a machine that passes a cookie must leave the cookie out for that run.

## Pitfalls

- `vacations create` is a real approval request: it rejects an end date before the start (`The end date ... is before the start date ...`) and a range that overlaps any existing non-cancelled absence (`... overlaps ... (id ...)`), and there is no `--force`.
- `vacations list` hides what is already past: an absence whose end date is before today is not printed, and cancelled requests are omitted. A missing row may simply be historical.
- The leave type is matched by substring (case- and whitespace-insensitive) against five fixed labels. An ambiguous fragment fails with `matches several ...`, an unknown one with `No ... matches "...". Closest: ...`; use the full label when unsure.
- There is no edit or cancel verb: a wrong request must be fixed in the NetSuite UI. Check the dates in the printed `Created ...` line before considering the task done.
- The session is a cached cookie that expires after roughly thirty idle minutes; every run probes it and the CLI signs in again through the browser when it has expired. Only one Chrome may run on the shared profile `~/.cache/netsuite-cli/browser-profile`, so close other runs or windows before retrying a `The browser could not be started` error.
- Errors go to stderr as `netsuite-cli: ...`. A usage error exits 1, a NetSuite or session failure exits 2.

## Verification

1. `netsuite-cli vacations list` shows the filed vacation with status `Approval Requested` and the expected start and end dates.
2. `netsuite-cli --json vacations list` returns the same request with the matching `startDate`, `endDate` and `statusLabel`.
3. A range that overlaps an existing absence is refused, which proves the new request did not duplicate a day.
