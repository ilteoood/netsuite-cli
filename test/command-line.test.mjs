import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { errorReport, parseCommandLine, usageText, weekDaysOf } from "../bin/netsuite-cli.mjs";
import { NetsuiteError, UsageError } from "../src/errors.mjs";

const binary = fileURLToPath(new URL("../bin/netsuite-cli.mjs", import.meta.url));
const run = (...argv) => spawnSync(process.execPath, [binary, ...argv], { encoding: "utf8" });
// os.homedir() reads HOME on posix and USERPROFILE on win32, so both point at the temporary home
const isolatedHome = (home) => ({ ...process.env, HOME: home, USERPROFILE: home });
const usageError = (argv) => {
	try {
		parseCommandLine(argv);
	} catch (error) {
		assert.ok(error instanceof UsageError, error.message);
		return error.message;
	}
	assert.fail(`expected a UsageError for ${argv.join(" ")}`);
};

test("parseCommandLine reads the globals before the resource and the flags after the verb", () => {
	assert.deepEqual(
		parseCommandLine([
			"--json",
			"--login-url",
			"https://1234567.app.netsuite.com/app/login.nl",
			"--cookie-file",
			"/tmp/cookie.txt",
			"timesheet",
			"fill",
			"--project",
			"Acme Platform",
			"--task",
			"WebPortal",
			"--hours",
			"8",
		]),
		{
			globals: {
				loginUrl: "https://1234567.app.netsuite.com/app/login.nl",
				cookieFile: "/tmp/cookie.txt",
				json: true,
			},
			resource: "timesheet",
			verb: "fill",
			flags: {
				project: "Acme Platform",
				task: "WebPortal",
				hours: "8",
				"dry-run": false,
				force: false,
				submit: false,
			},
			help: null,
		},
	);
});

test("parseCommandLine defaults the globals and the boolean flags", () => {
	const command = parseCommandLine([
		"timesheet",
		"add",
		"--date",
		"2026-11-16",
		"--project",
		"Acme",
		"--task",
		"Web",
		"--hours",
		"2",
	]);
	assert.deepEqual(command.globals, { loginUrl: null, cookieFile: null, json: false });
	assert.deepEqual(command.flags, { date: "2026-11-16", project: "Acme", task: "Web", hours: "2" });
});

test("parseCommandLine accepts --flag=value", () => {
	const command = parseCommandLine(["--login-url=https://example.test/login", "vacations", "list"]);
	assert.equal(command.globals.loginUrl, "https://example.test/login");
	assert.deepEqual(command.flags, {});
});

test("parseCommandLine rejects a global flag after the resource", () => {
	assert.equal(
		usageError(["timesheet", "fill", "--json", "--project", "Acme", "--task", "Web", "--hours", "8"]),
		'"--json" is a global flag and goes before "timesheet"',
	);
});

test("parseCommandLine rejects a global flag before the verb", () => {
	assert.match(usageError(["timesheet", "--cookie-file", "c.txt", "fill"]), /global flag/);
});

test("parseCommandLine rejects an unknown global flag", () => {
	assert.equal(usageError(["--verbose", "projects", "list"]), 'unknown flag "--verbose"');
});

test("parseCommandLine rejects an unknown flag of a verb", () => {
	assert.equal(usageError(["projects", "list", "--week", "2026-11-16"]), 'unknown flag "--week"');
});

test("parseCommandLine rejects an unexpected argument after the verb", () => {
	assert.match(usageError(["projects", "list", "extra"]), /extra/);
});

test("parseCommandLine rejects a missing resource", () => {
	assert.match(usageError([]), /missing the resource/);
});

test("parseCommandLine rejects a missing verb", () => {
	assert.equal(usageError(["vacations"]), 'missing the verb for "vacations"; available: list, create');
});

test("parseCommandLine names the available verbs when the verb is unknown", () => {
	assert.equal(usageError(["timesheet", "show"]), 'unknown verb "show" for "timesheet"; available: fill, add');
});

test("parseCommandLine names the available resources when the resource is unknown", () => {
	assert.equal(usageError(["time", "fill"]), 'unknown resource "time"; available: projects, vacations, timesheet');
});

test("parseCommandLine rejects a verb without its required flags", () => {
	assert.equal(usageError(["vacations", "create", "--start", "2027-04-14"]), '"vacations create" needs --type <name>');
});

test("parseCommandLine reports the root help", () => {
	assert.deepEqual(parseCommandLine(["--help"]), {
		globals: { loginUrl: null, cookieFile: null, json: false },
		resource: null,
		verb: null,
		flags: {},
		help: "root",
	});
	assert.deepEqual(parseCommandLine(["--help", "timesheet"]).help, "root");
});

test("parseCommandLine reads --clear as a standalone command", () => {
	assert.deepEqual(parseCommandLine(["--clear"]), {
		globals: { loginUrl: null, cookieFile: null, json: false },
		resource: null,
		verb: null,
		flags: {},
		help: null,
		clear: true,
	});
	assert.equal(parseCommandLine(["--json", "--clear"]).clear, true);
});

test("parseCommandLine rejects --clear combined with a command", () => {
	assert.equal(usageError(["--clear", "projects", "list"]), '"--clear" cannot be combined with a command');
	assert.equal(usageError(["projects", "list", "--clear"]), '"--clear" cannot be combined with a command');
});

test("parseCommandLine names an unknown verb before a misplaced global flag", () => {
	assert.equal(
		usageError(["timesheet", "bogus", "--clear"]),
		'unknown verb "bogus" for "timesheet"; available: fill, add',
	);
});

test("parseCommandLine reports the help of a verb and of a resource", () => {
	const verb = parseCommandLine(["timesheet", "fill", "--help"]);
	assert.equal(verb.help, "timesheet fill");
	assert.equal(verb.verb, "fill");
	assert.equal(parseCommandLine(["timesheet", "--help"]).help, "timesheet");
});

test("usageText prints every command at the root and only its own flags for a verb", () => {
	const root = usageText(null);
	for (const key of ["projects list", "vacations list", "vacations create", "timesheet fill", "timesheet add"]) {
		assert.ok(root.includes(key), key);
	}
	const globalBlock = root.split("Global flags, before the resource:")[1].split("Standalone flag, with no command:")[0];
	assert.ok(globalBlock.includes("--login-url <url>"));
	assert.ok(!globalBlock.includes("--clear"));
	assert.ok(root.split("Standalone flag, with no command:")[1].includes("--clear"));
	const verb = usageText("timesheet fill");
	assert.ok(verb.includes("--force"));
	assert.ok(verb.includes("--submit"));
	assert.ok(!verb.includes("--start"));
	assert.ok(!verb.includes("--reference"));
	assert.ok(verb.includes("Global flags go before the resource: --login-url, --cookie-file, --json."));
});

test("errorReport maps UsageError to exit 1 and everything else to exit 2", () => {
	assert.deepEqual(errorReport(new UsageError("bad flag")), { exitCode: 1, message: "bad flag" });
	const netsuite = new NetsuiteError("NetSuite refused the write", { status: 403, detail: "Permission Violation" });
	assert.deepEqual(errorReport(netsuite), {
		exitCode: 2,
		message: "NetSuite refused the write: Permission Violation",
	});
	assert.deepEqual(errorReport(new Error("boom")), { exitCode: 2, message: "boom" });
	assert.deepEqual(errorReport("boom"), { exitCode: 2, message: "boom" });
});

test("the binary prints the usage on --help and exits 0", () => {
	const result = run("--help");
	assert.equal(result.status, 0);
	assert.ok(result.stdout.startsWith("Usage: netsuite-cli "));
	assert.equal(result.stderr, "");
});

test("the binary prints a prefixed error line and exits 1 on a usage error", () => {
	const result = run("timesheet", "show");
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /^netsuite-cli: unknown verb "show" for "timesheet"/);
});

test("the binary prefixes a missing option value and exits 1", () => {
	const result = run("--login-url");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^netsuite-cli: Option '--login-url <value>' argument missing/);
});

test("the binary removes the cache directory on --clear", () => {
	const home = mkdtempSync(join(tmpdir(), "netsuite-clear-"));
	mkdirSync(join(home, ".cache", "netsuite-cli", "browser-profile"), { recursive: true });
	mkdirSync(join(home, ".cache", "other-app"), { recursive: true });

	const result = spawnSync(process.execPath, [binary, "--clear"], {
		encoding: "utf8",
		env: isolatedHome(home),
	});

	assert.equal(result.status, 0);
	assert.match(result.stdout, /Removed .*netsuite-cli/);
	assert.equal(existsSync(join(home, ".cache", "netsuite-cli")), false);
	assert.equal(existsSync(join(home, ".cache", "other-app")), true);
});

test("the binary prints the removal as JSON with --clear --json", () => {
	const home = mkdtempSync(join(tmpdir(), "netsuite-clear-"));
	mkdirSync(join(home, ".cache", "netsuite-cli"), { recursive: true });

	const result = spawnSync(process.execPath, [binary, "--clear", "--json"], {
		encoding: "utf8",
		env: isolatedHome(home),
	});

	assert.equal(result.status, 0);
	assert.deepEqual(JSON.parse(result.stdout), {
		removed: true,
		directory: join(home, ".cache", "netsuite-cli"),
	});
});

test("the binary rejects --clear combined with a command and exits 1", () => {
	const result = run("--clear", "projects", "list");
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /^netsuite-cli: "--clear" cannot be combined with a command/);
});

test("parseCommandLine does not read a flag value as a global flag", () => {
	const command = parseCommandLine([
		"vacations",
		"create",
		"--start",
		"2027-04-14",
		"--type",
		"Annual Leave",
		"--memo=--json",
	]);
	assert.equal(command.flags.memo, "--json");
	assert.doesNotMatch(usageError(["vacations", "create", "--memo", "--json"]), /global flag/);
	assert.doesNotMatch(usageError(["vacations", "create", "--memo", "--help"]), /global flag/);
});

test("weekDaysOf turns day names into the dates of the week, defaulting to the working week", () => {
	assert.deepEqual(weekDaysOf("2026-11-09"), ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
	assert.deepEqual(weekDaysOf("2026-11-09", "WED, sat"), ["2026-11-11", "2026-11-14"]);
	assert.throws(() => weekDaysOf("2026-11-09", "mon,funday"), UsageError);
});
