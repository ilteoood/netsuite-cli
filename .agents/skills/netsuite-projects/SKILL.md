---

name: "netsuite-projects"
description: "List the NetSuite projects of the signed-in account with the netsuite-cli binary, to learn the project names and ids a timesheet accepts: \"list my projects\", \"which projects can I book time on\", \"what is the project id for X\", \"projects list\"."
---

## When to Use

Use when asked which projects the NetSuite timesheet offers, or which project name or id to pass to `timesheet fill` and `timesheet add`, for the account the CLI is signed in as. The tool is the `netsuite-cli` binary (run as `npx github:ilteoood/netsuite-cli`, no install needed) and the command is `npx github:ilteoood/netsuite-cli projects list`; `npx github:ilteoood/netsuite-cli projects list --help` lists the flags. Writing time is the `netsuite-timesheet` skill; this one only reads.

## Procedure

1. `npx github:ilteoood/netsuite-cli projects list` prints the project names and ids offered by the timesheet page of the current week.
2. `npx github:ilteoood/netsuite-cli --json projects list` prints the same rows as JSON when the caller needs ids without parsing the table.
3. The session flags are global and go before the resource: `npx github:ilteoood/netsuite-cli --cookie-file ~/cookie.txt projects list`. Without a cookie the CLI opens Chrome on the NetSuite sign-in page and caches the session in `~/.cache/netsuite-cli/session.json`. The account itself is only known from that cache or from `npx github:ilteoood/netsuite-cli login <url>`, which signs in on the pasted NetSuite sign-in page and stores it for the later sign-ins, so a cookie alone is not enough on a machine that never signed in through the browser.
4. A stuck browser profile is cleared on its own: `npx github:ilteoood/netsuite-cli --clear` removes `~/.cache/netsuite-cli` (the shared Chrome profile, the cached session and the stored login page) and exits. It stands alone and takes no command. Close every Chrome window before running it, and run `npx github:ilteoood/netsuite-cli login <url>` again afterwards, because the cleared cache held the account and the page; a machine that passes a cookie must leave the cookie out for that run.

## Pitfalls

- The list belongs to the current week only: it reads the timesheet record of this week, so `No timesheet exists for the week starting X` means NetSuite has no record for the current week (a closed accounting period, or a wrong week), not that the project is missing.
- The ids are the ones a timesheet entry needs. A name typed at `timesheet fill` or `timesheet add` is matched by substring (case- and whitespace-insensitive), so an ambiguous fragment fails with `matches several ...` and an unknown one fails with `No ... matches "...". Closest: ...`; a longer fragment fixes both.
- Only projects of the timesheet page are listed: a project that exists in NetSuite but is not bookable time is not here, and cannot be passed to the timesheet commands.
- The session is a cached cookie that expires after roughly thirty idle minutes; every run probes it and the CLI signs in again through the browser when it has expired. Only one Chrome may run on the shared profile `~/.cache/netsuite-cli/browser-profile`, so close other runs or windows before retrying a `The browser could not be started` error.
- Errors go to stderr as `netsuite-cli: ...`. A usage error exits 1, a NetSuite or session failure exits 2.

## Verification

1. `npx github:ilteoood/netsuite-cli projects list` prints a table with the `Project` and `Id` columns, one line per project, and the exit code is 0.
2. `npx github:ilteoood/netsuite-cli --json projects list` prints the same projects as a JSON array.
3. The project name and id used in a `timesheet fill --dry-run` plan appear in that listing.
