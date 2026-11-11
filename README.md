# netsuite-cli

Command-line client for the NetSuite timesheet and vacation records of the signed-in employee. It reads and writes the weekly timesheet over the NetSuite REST API and files vacation requests on the same account.

## Installation

Requires Node.js 26 or newer. A Chrome or Chromium installation is needed for the first sign-in.

```bash
npm install
npm link        # optional: puts `netsuite-cli` on the PATH
```

Without `npm link`, run `node bin/netsuite-cli.mjs` instead of `netsuite-cli`. `npm test` runs the test suite.

## Authentication

The first command opens a headful Chrome window on the NetSuite sign-in page and waits for you to sign in. The window closes by itself once the session cookie is captured. On a machine with no cached account, `--login-url` is required because it is the only way to learn which account to use, for example:

```bash
netsuite-cli --login-url 'https://accounts.google.com/o/saml2/initsso?idpid=C00example&spid=0000000000000000&forceauthn=false' projects list
```

The browser uses one shared profile in `~/.cache/netsuite-cli/browser-profile`, so the identity provider usually remembers the account and later sign-ins need no typing. The captured session cookie and its account are cached in `~/.cache/netsuite-cli/session.json`, readable only by you (mode 600).
Run `netsuite-cli --clear` to remove the profile and the cached session. The next command needs a browser sign-in again (`--login-url`), because the cached session is the only place the account is kept; a machine that passes a cookie must leave the cookie out for that run.

Every run probes the cached session first. If it has expired, the CLI signs in again through the same browser profile and retries the request, so normal use does not require re-entering credentials. The browser is located automatically by `chrome-launcher`; set `NETSUITE_BROWSER` to the path of a specific Chrome or Chromium binary when several are installed.

On a machine that cannot open a browser, provide the cookie instead:

```bash
netsuite-cli --cookie-file ~/netsuite-cookie.txt vacations list
export NETSUITE_COOKIE='JSESSIONID=…'
netsuite-cli vacations list
```

The file may contain the raw `Cookie` header value; only `JSESSIONID` is needed, and a leading `Cookie:` is ignored. The account still comes from the cached session, so a cookie-only machine needs the `session.json` produced by an earlier browser sign-in. The cookie is checked before any command runs, and an expired one fails fast with an actionable error.

## Global flags

Global flags must come before the resource:

| Flag                   | Meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `--login-url <url>`    | NetSuite sign-in page to open when a browser sign-in is needed |
| `--cookie-file <path>` | Read the session cookie from a file, no browser                |
| `--json`               | Print the result as JSON                                       |

`--help` works anywhere: `netsuite-cli --help` lists the resources, `netsuite-cli <resource> --help` lists the verbs of one resource, and `netsuite-cli <resource> <verb> --help` lists the flags of one command.

`--clear` is a standalone flag: it takes no command and cannot be combined with one.

## Clearing the profile

`--clear` removes the whole `~/.cache/netsuite-cli` directory: the shared Chrome profile and the cached session. Use it when the profile is locked, corrupted, or holds an account that must be forgotten. The flag stands alone and cannot be combined with a command. Close every Chrome window first, because a running Chrome keeps writing to the profile while it is being removed.

```bash
netsuite-cli --clear
```

```text
Removed /home/user/.cache/netsuite-cli and its contents (browser profile and cached session)
```

The next command signs in again from a fresh profile and needs `--login-url` again, because the cleared cache held the account; a machine that passes a cookie must leave the cookie out for that run.

## Commands

| Command            | Purpose                                       |
| ------------------ | --------------------------------------------- |
| `projects list`    | List the projects available for the timesheet |
| `vacations list`   | List the upcoming vacations                   |
| `vacations create` | Create a vacation request                     |
| `timesheet fill`   | Fill a week of the timesheet with one project |
| `timesheet add`    | Add one row to the timesheet of a date        |

### `projects list`

Lists the projects offered by the timesheet page of the current week.

```bash
netsuite-cli projects list
```

```text
Project                          Id
Acme Platform                    1234
Internal Tools                   1240
```

```bash
netsuite-cli --json projects list
```

### `vacations list`

Lists the vacations visible to the signed-in user whose end date is today or later, sorted by start date. Cancelled requests are omitted.

```bash
netsuite-cli vacations list
```

```text
Type            Start       End         Status    Days  Id
Bank Holiday    2026-12-25  2026-12-25  Approved        80001
Annual Leave    2026-12-28  2026-12-31  Approved  4     80002
```

```bash
netsuite-cli --json vacations list
```

```json
[
	{
		"id": "80002",
		"typeId": "84",
		"typeLabel": "Annual Leave",
		"startDate": "2026-12-28",
		"endDate": "2026-12-31",
		"statusId": "1",
		"statusLabel": "Approved",
		"days": "4"
	}
]
```

### `vacations create`

Files a real approval request for a date range. `--start` and `--type` are required; `--end` defaults to `--start`. The leave type is matched case-insensitively by substring against `Annual Leave`, `Bank Holiday`, `Training`, `Event Leave` and `Other Leave`. The reference defaults to the type and the dates.

```bash
netsuite-cli vacations create --start 2027-01-11 --end 2027-01-15 --type "Annual Leave" --memo "Family holiday"
```

```text
Created Annual Leave 2027-01-11 → 2027-01-15 (id 80003)
```

The new request is created with status `Approval Requested`. Use `--reference "…"` to set its name explicitly.

### `timesheet fill`

Fills one project and task for a whole week. `--project`, `--task` and `--hours` are required. With no `--week`, the current week is used.

```bash
netsuite-cli timesheet fill --week 2026-11-09 --project acme --task development --hours 8
```

```text
Wrote 5 created, 0 replaced, 0 removed, 40:00 in the week of 2026-11-09
```

Hours are per day and accept decimals or `H:MM`. The default days are Monday to Friday; `--days` takes a comma-separated list such as `mon,tue,wed`. `--memo` defaults to the task name, and `--activity` defaults to `Solution Delivery` (id 71).

Print the plan without writing:

```bash
netsuite-cli timesheet fill --week 2026-11-09 --project acme --task development --hours 7:30 --days mon,wed,fri --dry-run
```

Update a week that already contains hours for this project, using a memo on every entry, then submit the timesheet:

```bash
netsuite-cli timesheet fill --week 2026-11-09 --project acme --task development --hours 8 --memo "Acme platform" --force --submit
```

### `timesheet add`

Adds a single row to the week of the given date, for example an extra project on one day.

```bash
netsuite-cli timesheet add --date 2026-11-12 --project internal --task support --hours 2 --memo "Incident review"
```

```text
Wrote 1 created, 0 replaced, 0 removed, 42:00 in the week of 2026-11-09
```

If a row for the same date, project and task already exists with different hours or memo, it is replaced. Other rows are left alone.

## Invariants

- `--week` must be the Monday of the week, in `YYYY-MM-DD`. The current week is the default.
- A missing timesheet record means the week is wrong or has not been created. NetSuite pre-creates the weekly timesheet records; the CLI never creates one and fails with `No timesheet exists for the week starting …`. Weeks in a closed accounting period cannot be written to either.
- `--project` and `--task` are matched case-insensitively by substring on their names. A name that matches several candidates fails and lists them, so use a longer, more specific name. An unknown name fails and suggests the closest candidates.
- `timesheet fill` writes one project and task per run. Rows of other projects and tasks are left untouched; rows of the selected project and task on days outside `--days` are removed.
- `--dry-run` prints the plan and writes nothing.
- `timesheet fill` refuses to change or remove existing hours unless `--force` is given; nothing is written in that case.
- Weeks with approved time entries cannot be changed, even with `--force`.
- `--submit` requires a memo on every entry in the timesheet before NetSuite accepts the submission. `timesheet fill` stores the task name as the memo unless `--memo` is given.
- `vacations create` files a real approval request and refuses to create a range that overlaps any existing non-cancelled vacation of the employee. An end date before the start date is rejected.
- `--json` must be a global flag, before the resource. Commands print a JSON array or object instead of a table or a sentence.
- `--clear` stands alone: it removes the cache and exits, and cannot be combined with a command.

Errors are written to stderr as `netsuite-cli: …`. A usage error exits with status 1, and a NetSuite or session failure exits with status 2.
