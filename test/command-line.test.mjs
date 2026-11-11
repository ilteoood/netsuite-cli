import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildProgram, errorReport, weekDaysOf } from "../bin/netsuite-cli.mjs";
import { NetsuiteError, UsageError } from "../src/errors.mjs";

const binary = fileURLToPath(new URL("../bin/netsuite-cli.mjs", import.meta.url));
const run = (...argv) => spawnSync(process.execPath, [binary, ...argv], { encoding: "utf8" });
// os.homedir() reads HOME on posix and USERPROFILE on win32, so both point at the temporary home
const isolatedHome = (home) => ({ ...process.env, HOME: home, USERPROFILE: home });
const parse = async (argv) => {
	const dispatched = [];
	const program = buildProgram(async (command) => {
		dispatched.push(command);
	});
	await program.parseAsync(argv, { from: "user" });
	return dispatched;
};

test("the parser reads the globals before the resource and the flags after the verb", async () => {
	const [command] = await parse([
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
	]);
	assert.deepEqual(command.globals, {
		loginUrl: "https://1234567.app.netsuite.com/app/login.nl",
		cookieFile: "/tmp/cookie.txt",
		json: true,
	});
	assert.deepEqual(command.flags, { project: "Acme Platform", task: "WebPortal", hours: "8" });
	assert.equal(command.key, "timesheet fill");
});

test("the parser defaults the globals and leaves the flags out", async () => {
	const [command] = await parse(["projects", "list"]);
	assert.deepEqual(command.globals, { loginUrl: null, cookieFile: null, json: false });
	assert.deepEqual(command.flags, {});
});

test("the parser accepts --flag=value", async () => {
	const [command] = await parse(["--login-url=https://example.test/login", "vacations", "list"]);
	assert.equal(command.globals.loginUrl, "https://example.test/login");
});

test("the parser reads a flag value as a value and not as a global flag", async () => {
	const [command] = await parse([
		"vacations",
		"create",
		"--start",
		"2027-04-14",
		"--type",
		"Annual Leave",
		"--memo=--json",
	]);
	assert.equal(command.flags.memo, "--json");
});

test("the parser keeps the boolean flags out until they are given", async () => {
	const [without] = await parse(["timesheet", "fill", "--project", "Acme", "--task", "Web", "--hours", "8"]);
	assert.equal(without.flags.dryRun, undefined);
	const [given] = await parse(["timesheet", "fill", "--project", "Acme", "--task", "Web", "--hours", "8", "--dry-run"]);
	assert.equal(given.flags.dryRun, true);
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

test("the binary lists the resources and the global flags on the root help", () => {
	const result = run("--help");
	for (const resource of ["projects", "vacations", "timesheet"]) {
		assert.match(result.stdout, new RegExp(resource));
	}
	assert.match(result.stdout, /--login-url <url>/);
	assert.match(result.stdout, /--cookie-file <path>/);
	assert.match(result.stdout, /--json/);
	assert.match(result.stdout, /--clear/);
});

test("the binary prints the flags of one verb and no flag of another", () => {
	const result = run("timesheet", "fill", "--help");
	assert.equal(result.status, 0);
	assert.match(result.stdout, /Usage: netsuite-cli timesheet fill/);
	assert.match(result.stdout, /--dry-run/);
	assert.match(result.stdout, /--submit/);
	assert.doesNotMatch(result.stdout, /--start/);
	assert.match(result.stdout, /Global flags go before the resource: --login-url, --cookie-file, --json\./);
});

test("the binary prints a prefixed error line and exits 1 on an unknown verb", () => {
	const result = run("timesheet", "show");
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /^netsuite-cli: unknown command 'show'/);
});

test("the binary names the available resources when the resource is unknown", () => {
	const result = run("time", "fill");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^netsuite-cli: unknown resource "time"; available: projects, vacations, timesheet/);
});

test("the binary prints the help of a resource and exits 1 when the verb is missing", () => {
	const result = run("vacations");
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /Usage: netsuite-cli vacations/);
});

test("the binary rejects a global flag after the resource", () => {
	const result = run("timesheet", "fill", "--json", "--project", "Acme", "--task", "Web", "--hours", "8");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^netsuite-cli: unknown option '--json'/);
});

test("the binary rejects a global flag before the verb", () => {
	const result = run("timesheet", "--cookie-file", "c.txt", "fill");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^netsuite-cli: unknown option '--cookie-file'/);
});

test("the binary rejects a missing resource", () => {
	const result = run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^netsuite-cli: missing the resource/);
});

test("the binary rejects an unknown flag", () => {
	const result = run("--verbose", "projects", "list");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^netsuite-cli: unknown option '--verbose'/);
});

test("the binary rejects a flag of another verb", () => {
	const result = run("projects", "list", "--week", "2026-11-16");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^netsuite-cli: unknown option '--week'/);
});

test("the binary rejects an unexpected argument after the verb", () => {
	const result = run("projects", "list", "extra");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^netsuite-cli: too many arguments for 'list'/);
});

test("the binary prefixes a missing option value and exits 1", () => {
	const result = run("--login-url");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^netsuite-cli: option '--login-url <url>' argument missing/);
});

test("the binary names the missing required flag of a verb", () => {
	const result = run("vacations", "create", "--start", "2027-04-14");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^netsuite-cli: required option '--type <name>' not specified/);
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
	for (const argv of [
		["--clear", "projects"],
		["--clear", "projects", "list"],
		["projects", "list", "--clear"],
	]) {
		const result = run(...argv);
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /^netsuite-cli: "--clear" cannot be combined with a command/);
	}
});

test("the binary refuses a --clear typed between the resource and the verb", () => {
	const result = run("projects", "--clear", "list");
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /^netsuite-cli: unknown option '--clear'/);
});

test("weekDaysOf turns day names into the dates of the week, defaulting to the working week", () => {
	assert.deepEqual(weekDaysOf("2026-11-09"), ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
	assert.deepEqual(weekDaysOf("2026-11-09", "WED, sat"), ["2026-11-11", "2026-11-14"]);
	assert.throws(() => weekDaysOf("2026-11-09", "mon,funday"), UsageError);
});
