---

name: "netsuite-profile"
description: "Export or import the browser profile that holds the NetSuite login with the netsuite-cli binary, to move a sign-in to another machine: \"export my netsuite profile\", \"import the profile on this machine\", \"move the login to another machine\", \"profile export\", \"profile import\"."
---

## When to Use

Use when asked to move the NetSuite sign-in from one machine to another, to keep a copy of the login profile, or to restore a profile that was exported earlier. The tool is the `netsuite-cli` binary (run as `npx github:ilteoood/netsuite-cli`, no install needed) and the two verbs are `profile export` and `profile import`; `npx github:ilteoood/netsuite-cli profile export --help` lists the flags.

## Procedure

1. Export the profile of the machine that is already signed in: `npx github:ilteoood/netsuite-cli profile export ~/netsuite-profile.tar.gz`, which prints `Exported the browser profile to <path> (<bytes> bytes)`. The archive holds the shared Chrome profile `~/.cache/netsuite-cli/browser-profile`, the cached session `~/.cache/netsuite-cli/session.json` and the identity provider cookies `~/.cache/netsuite-cli/login-cookies.json`.
2. Move the archive to the other machine over a channel that is safe for a credential, because it contains the live session cookie and the live identity provider cookies.
3. Import it there: `npx github:ilteoood/netsuite-cli profile import ~/netsuite-profile.tar.gz`, which prints `Imported the browser profile into <path> and the cached session and the login cookies`. The next command signs in without opening a browser.
4. The import refuses to replace a profile that is already on the machine. Add `--force` to overwrite it: `npx github:ilteoood/netsuite-cli profile import ~/netsuite-profile.tar.gz --force`.
5. The flags are global and go before the resource: `npx github:ilteoood/netsuite-cli --json profile export ~/netsuite-profile.tar.gz` prints the archive path and its size as JSON.

## Pitfalls

- The archive is a live credential: it carries the session cookie and the identity provider cookies, and it is written readable only by the owner (mode 600). Do not attach it to a ticket, a chat or a repository.
- The Chrome profile only signs in on a machine with the same key store, so the cookies of the identity provider travel as plain values in `login-cookies.json` and are replayed into the browser on import. That makes a sign-in portable across operating systems too, for example from Chrome on macOS to Chromium on Linux.
- `login-cookies.json` is captured while signing in, so it holds the state of that sign-in: run `npx github:ilteoood/netsuite-cli login <url>` again before exporting when the identity provider session changed since.
- A profile exported by a machine that signed in before `login-cookies.json` existed carries no cookies: the import still works, but the identity provider asks for the account once, and the sign-in after that writes the file.
- Both verbs refuse to run while a Chrome window holds the profile (`Chrome is using the login profile at ...`): close every Chrome window and run the command again. A lock left behind by a killed Chrome is stale and does not block the command.
- `profile import --force` empties `~/.cache/netsuite-cli` before it extracts, so the archive cannot live inside that directory.
- `profile export` needs a profile to export: on a machine that never signed in it fails with `There is no browser profile to export yet`, and the sign-in has to happen first with `npx github:ilteoood/netsuite-cli login <url>`.
- `profile import` only reads archives produced by `profile export`; any other tarball is refused with `is not a netsuite-cli profile archive`.
- The session cookie expires after roughly thirty idle minutes. An imported session that has expired sends the next command back through the browser, so an import is not a permanent replacement for a sign-in.
- Errors go to stderr as `netsuite-cli: ...`. A usage error exits 1, a NetSuite or session failure exits 2.

## Verification

1. `npx github:ilteoood/netsuite-cli profile export <path>` prints the exported archive and the exit code is 0.
2. `npx github:ilteoood/netsuite-cli profile import <path>` on the other machine prints the imported profile directory and the exit code is 0.
3. `npx github:ilteoood/netsuite-cli --json profile import <path>` returns the archive path and the profile directory, which proves the import landed in `~/.cache/netsuite-cli`.
