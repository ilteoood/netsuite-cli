# netsuite-cli

Command-line client for the NetSuite timesheet and vacation records of the signed-in employee. It reads and writes the weekly timesheet over the NetSuite REST API and files vacation requests on the same account.

## Installation

Requires Node.js 26 or newer. `npm install` downloads the Chrome for Testing build that the first sign-in opens.

```bash
npm install
npm link        # optional: puts `netsuite-cli` on the PATH
```

Without `npm link`, run `node bin/netsuite-cli.mjs` instead of `netsuite-cli`. `npm test` runs the test suite.

## Authentication

Sign in once with the NetSuite sign-in page:

```bash
netsuite-cli login 'https://accounts.google.com/o/saml2/initsso?idpid=C00example&spid=0000000000000000&forceauthn=false'
```

A headful Chrome window opens on that page and waits for you to sign in. The window closes by itself once the session cookie is captured, and the command prints the account it found. The page is stored with the session, so `netsuite-cli login` with no argument opens the stored page again; the URL is only needed the first time and after `--clear`, because it is the only way to learn which account to use. Every other command signs in the same way when the cached session is missing or expired, with no flag to pass; on a machine that never signed in, it stops and asks for `netsuite-cli login <url>` first.

The browser uses one shared profile in `~/.cache/netsuite-cli/browser-profile`, so the identity provider usually remembers the account and later sign-ins need no typing. The captured session cookie and its account are cached in `~/.cache/netsuite-cli/session.json`, readable only by you (mode 600). The cookies of the identity provider sign-in are cached next to it in `~/.cache/netsuite-cli/login-cookies.json`, also mode 600, and are replayed into the browser on the next sign-in so that the identity provider does not ask for the account again.
Run `netsuite-cli --clear` to remove the profile, the cached session, the login cookies and the stored login page. The next sign-in needs the page again, because the cleared cache is the only place the account and the page are kept; a machine that passes a cookie must leave the cookie out for that run.

Every run probes the cached session first. If it has expired, the CLI signs in again through the same browser profile and retries the request, so normal use does not require re-entering credentials. The browser is the Chrome for Testing build downloaded by `puppeteer`; set `NETSUITE_BROWSER` to the path of a specific Chrome or Chromium binary to use that one instead.

On a machine that cannot open a browser, provide the cookie instead:

```bash
netsuite-cli --cookie-file ~/netsuite-cookie.txt vacations list
export NETSUITE_COOKIE='JSESSIONID=…'
netsuite-cli vacations list
```

The file may contain the raw `Cookie` header value; only `JSESSIONID` is needed, and a leading `Cookie:` is ignored. The account still comes from the cached session, so a cookie-only machine needs the `session.json` produced by an earlier browser sign-in. The cookie is checked before any command runs, and an expired one fails fast with an actionable error.

## Global flags

Global flags must come before the resource:

| Flag                   | Meaning                                         |
| ---------------------- | ----------------------------------------------- |
| `--cookie-file <path>` | Read the session cookie from a file, no browser |
| `--json`               | Print the result as JSON                        |

`--help` works anywhere: `netsuite-cli --help` lists the resources, `netsuite-cli <resource> --help` lists the verbs of one resource, and `netsuite-cli <resource> <verb> --help` lists the flags of one command.

`--clear` is a standalone flag: it takes no command and cannot be combined with one.

## Clearing the profile

`--clear` removes the whole `~/.cache/netsuite-cli` directory: the shared Chrome profile, the cached session, the login cookies and the stored login page. Use it when the profile is locked, corrupted, or holds an account that must be forgotten. The flag stands alone and cannot be combined with a command. Close every Chrome window first, because a running Chrome keeps writing to the profile while it is being removed.

```bash
netsuite-cli --clear
```

```text
Removed /home/user/.cache/netsuite-cli and its contents (browser profile, cached session, login cookies and login page)
```

The next sign-in needs `netsuite-cli login <url>` again from a fresh profile, because the cleared cache held the account and the page; a machine that passes a cookie must leave the cookie out for that run.

## Commands

| Command            | Purpose                                       |
| ------------------ | --------------------------------------------- |
| `projects list`    | List the projects available for the timesheet |
| `vacations list`   | List the upcoming vacations                   |
| `vacations create` | Create a vacation request                     |
| `timesheet fill`   | Fill a week of the timesheet with one project |
| `timesheet add`    | Add one row to the timesheet of a date        |
| `profile export`   | Export the login browser profile              |
| `profile import`   | Import a browser profile archive              |

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

### `profile export`

Packs the shared Chrome profile, the cached session and the identity provider cookies into a `tar.gz` archive, so a sign-in that happened on one machine can be reused on another. The path is the archive to write.

```bash
netsuite-cli profile export ~/netsuite-profile.tar.gz
```

```text
Exported the browser profile to /home/user/netsuite-profile.tar.gz (28457344 bytes)
```

The archive holds the live session cookie, so it is written readable only by you (mode 600) and has to be moved like a credential. The throwaway Chrome caches are left out of it.

The Chrome profile keeps its cookies encrypted with the key store of the machine that wrote it, so the profile alone only signs in on a machine with the same key store. The identity provider cookies are captured as plain values while signing in and travel in `login-cookies.json`, which the import replays into the browser, so the sign-in keeps working on another machine and on another operating system: the Chrome of the importing machine re-encrypts them with its own key store. A machine that signed in before this file existed exports the profile without it, and the identity provider asks for the account once after the import.

### `profile import`

Restores an archive exported by `profile export` into `~/.cache/netsuite-cli`, so the next command signs in without a browser. The path is the archive to read.

```bash
netsuite-cli profile import ~/netsuite-profile.tar.gz
```

```text
Imported the browser profile into /home/user/.cache/netsuite-cli/browser-profile and the cached session and the login cookies
```

An archive that was not produced by this CLI is refused. A profile that is already on the machine is kept unless `--force` is given.

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
- `login` signs in through the browser and stores the sign-in page in the cache; later sign-ins reuse it, so the URL is only passed the first time and after `--clear`.
- `profile export` and `profile import` move the browser profile, the cached session and the login cookies. The archive holds a live session cookie and the live identity provider cookies, so it is written mode 600 and has to be moved like a credential.
- The login cookies are captured while signing in, so they hold the state of that sign-in: re-run `netsuite-cli login <url>` before exporting when the identity provider changed the session since.
- Both profile verbs refuse to run while a Chrome window holds the profile, and `profile import` refuses to replace a profile that is already on the machine unless `--force` is given.

Errors are written to stderr as `netsuite-cli: …`. A usage error exits with status 1, and a NetSuite or session failure exits with status 2.
