import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildProgram, errorReport, handlers, weekDaysOf } from "../bin/netsuite-cli.mjs";
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

	assert.deepStrictEqual(
		{ globals: command.globals, flags: command.flags, key: command.key },
		{
			globals: { cookieFile: "/tmp/cookie.txt", json: true },
			flags: { project: "Acme Platform", task: "WebPortal", hours: "8" },
			key: "timesheet fill",
		},
	);
});

test("the parser defaults the globals and leaves the flags out", async () => {
	const [command] = await parse(["projects", "list"]);

	assert.deepStrictEqual(
		{ globals: command.globals, flags: command.flags },
		{ globals: { cookieFile: null, json: false }, flags: {} },
	);
});

test("the parser accepts --flag=value", async () => {
	const [command] = await parse(["--cookie-file=/tmp/cookie.txt", "vacations", "list"]);
	assert.strictEqual(command.globals.cookieFile, "/tmp/cookie.txt");
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
	assert.strictEqual(command.flags.memo, "--json");
});

test("the parser keeps the boolean flags out until they are given", async () => {
	const [without] = await parse(["timesheet", "fill", "--project", "Acme", "--task", "Web", "--hours", "8"]);
	const [given] = await parse(["timesheet", "fill", "--project", "Acme", "--task", "Web", "--hours", "8", "--dry-run"]);

	assert.deepStrictEqual(
		{ without: without.flags.dryRun, given: given.flags.dryRun },
		{ without: undefined, given: true },
	);
});

test("errorReport maps UsageError to exit 1 and everything else to exit 2", () => {
	assert.deepStrictEqual(
		{
			usage: errorReport(new UsageError("bad flag")),
			netsuite: errorReport(
				new NetsuiteError("NetSuite refused the write", {
					status: 403,
					detail: "Permission Violation",
				}),
			),
			error: errorReport(new Error("boom")),
			text: errorReport("boom"),
		},
		{
			usage: { exitCode: 1, message: "bad flag" },
			netsuite: { exitCode: 2, message: "NetSuite refused the write: Permission Violation" },
			error: { exitCode: 2, message: "boom" },
			text: { exitCode: 2, message: "boom" },
		},
	);
});

test("the binary prints the usage on --help and exits 0", () => {
	const result = run("--help");

	assert.deepStrictEqual(
		{
			status: result.status,
			printsTheUsage: result.stdout.startsWith("Usage: netsuite-cli "),
			stderr: result.stderr,
		},
		{ status: 0, printsTheUsage: true, stderr: "" },
	);
});

test("the binary lists the resources and the global flags on the root help", () => {
	const result = run("--help");

	assert.deepStrictEqual(
		{
			resources: ["projects", "vacations", "timesheet", "profile"].filter((resource) =>
				result.stdout.includes(resource),
			),
			printsTheLoginUsage: result.stdout.includes("       netsuite-cli login [url]"),
			hasNoLoginUrlFlag: !result.stdout.includes("--login-url"),
			hasTheCookieFileFlag: result.stdout.includes("--cookie-file <path>"),
			hasTheJsonFlag: result.stdout.includes("--json"),
			hasTheClearFlag: result.stdout.includes("--clear"),
		},
		{
			resources: ["projects", "vacations", "timesheet", "profile"],
			printsTheLoginUsage: true,
			hasNoLoginUrlFlag: true,
			hasTheCookieFileFlag: true,
			hasTheJsonFlag: true,
			hasTheClearFlag: true,
		},
	);
});

test("the binary prints the flags of one verb and no flag of another", () => {
	const result = run("timesheet", "fill", "--help");

	assert.deepStrictEqual(
		{
			status: result.status,
			printsTheUsage: result.stdout.includes("Usage: netsuite-cli timesheet fill"),
			hasTheDryRunFlag: result.stdout.includes("--dry-run"),
			hasTheSubmitFlag: result.stdout.includes("--submit"),
			hasNoStartFlag: !result.stdout.includes("--start"),
			printsTheGlobalNote: result.stdout.includes("Global flags go before the resource: --cookie-file, --json."),
		},
		{
			status: 0,
			printsTheUsage: true,
			hasTheDryRunFlag: true,
			hasTheSubmitFlag: true,
			hasNoStartFlag: true,
			printsTheGlobalNote: true,
		},
	);
});

test("the binary prints a prefixed error line and exits 1 on an unknown verb", () => {
	const result = run("timesheet", "show");

	assert.deepStrictEqual(
		{ status: result.status, stdout: result.stdout, stderr: result.stderr },
		{
			status: 1,
			stdout: "",
			stderr: "netsuite-cli: unknown command 'show'\n",
		},
	);
});

test("the binary names the available resources when the resource is unknown", () => {
	const result = run("time", "fill");

	assert.deepStrictEqual(
		{ status: result.status, stderr: result.stderr },
		{
			status: 1,
			stderr: 'netsuite-cli: unknown resource "time"; available: login, projects, vacations, timesheet, profile\n',
		},
	);
});

test("the binary prints the help of a resource and exits 1 when the verb is missing", () => {
	const result = run("vacations");

	assert.deepStrictEqual(
		{
			status: result.status,
			stdout: result.stdout,
			printsTheUsage: result.stderr.startsWith("Usage: netsuite-cli vacations"),
		},
		{ status: 1, stdout: "", printsTheUsage: true },
	);
});

test("the binary rejects a global flag after the resource", () => {
	const result = run("timesheet", "fill", "--json", "--project", "Acme", "--task", "Web", "--hours", "8");

	assert.deepStrictEqual(
		{ status: result.status, stderr: result.stderr },
		{ status: 1, stderr: "netsuite-cli: unknown option '--json'\n" },
	);
});

test("the binary rejects a global flag before the verb", () => {
	const result = run("timesheet", "--cookie-file", "c.txt", "fill");

	assert.deepStrictEqual(
		{ status: result.status, stderr: result.stderr },
		{ status: 1, stderr: "netsuite-cli: unknown option '--cookie-file'\n" },
	);
});

test("the binary rejects a missing resource", () => {
	const result = run();

	assert.deepStrictEqual(
		{ status: result.status, stderr: result.stderr },
		{
			status: 1,
			stderr: 'netsuite-cli: missing the resource; run "netsuite-cli --help" for the command list\n',
		},
	);
});

test("the binary rejects an unknown flag", () => {
	const result = run("--verbose", "projects", "list");

	assert.deepStrictEqual(
		{ status: result.status, stderr: result.stderr },
		{ status: 1, stderr: "netsuite-cli: unknown option '--verbose'\n" },
	);
});

test("the binary rejects a flag of another verb", () => {
	const result = run("projects", "list", "--week", "2026-11-16");

	assert.deepStrictEqual(
		{ status: result.status, stderr: result.stderr },
		{ status: 1, stderr: "netsuite-cli: unknown option '--week'\n" },
	);
});

test("the binary rejects an unexpected argument after the verb", () => {
	const result = run("projects", "list", "extra");

	assert.deepStrictEqual(
		{ status: result.status, stderr: result.stderr },
		{
			status: 1,
			stderr: "netsuite-cli: too many arguments for 'list'. Expected 0 arguments but got 1: extra.\n",
		},
	);
});

test("the binary prefixes a missing option value and exits 1", () => {
	const result = run("--cookie-file");

	assert.deepStrictEqual(
		{ status: result.status, stderr: result.stderr },
		{ status: 1, stderr: "netsuite-cli: option '--cookie-file <path>' argument missing\n" },
	);
});

test("the parser sends login with its url and without one", async () => {
	const [withUrl] = await parse(["login", "https://example.test/sso"]);
	const [withoutUrl] = await parse(["login"]);

	assert.deepStrictEqual(
		{
			withUrl: { key: withUrl.key, flags: withUrl.flags },
			withoutUrl: { key: withoutUrl.key, flags: withoutUrl.flags },
		},
		{
			withUrl: { key: "login", flags: { url: "https://example.test/sso" } },
			withoutUrl: { key: "login", flags: { url: null } },
		},
	);
});

test("the login command asks for a browser window", async () => {
	const signIns = [];
	await handlers.login({
		globals: { cookieFile: null, json: true },
		flags: { url: "https://example.test/sso" },
		signIn: async (options) => {
			signIns.push(options);
			return { account: "1234567" };
		},
	});

	assert.deepStrictEqual(signIns, [{ loginUrl: "https://example.test/sso", headless: false }]);
});

test("the binary rejects a login url that is not an https page", () => {
	const result = run("login", "http://example.test/sso");

	assert.deepStrictEqual(
		{ status: result.status, stderr: result.stderr },
		{
			status: 1,
			stderr: 'netsuite-cli: login takes the NetSuite sign-in page as an https URL, not "http://example.test/sso"\n',
		},
	);
});

test("the binary refuses to combine login with a cookie file", () => {
	const result = run("--cookie-file", "/tmp/cookie.txt", "login", "https://example.test/sso");

	assert.deepStrictEqual(
		{ status: result.status, stderr: result.stderr },
		{
			status: 1,
			stderr: 'netsuite-cli: "login" signs in through the browser, so it cannot be combined with "--cookie-file"\n',
		},
	);
});

test("the binary asks for the login url when none is stored", () => {
	const home = mkdtempSync(join(tmpdir(), "netsuite-login-"));
	const result = spawnSync(process.execPath, [binary, "login"], {
		encoding: "utf8",
		env: isolatedHome(home),
	});

	assert.deepStrictEqual(
		{ status: result.status, stderr: result.stderr },
		{
			status: 1,
			stderr: 'netsuite-cli: login has no stored sign-in page yet; pass it: "netsuite-cli login <url>"\n',
		},
	);
});

test("the binary names the missing required flag of a verb", () => {
	const result = run("vacations", "create", "--start", "2027-04-14");

	assert.deepStrictEqual(
		{ status: result.status, stderr: result.stderr },
		{ status: 1, stderr: "netsuite-cli: required option '--type <name>' not specified\n" },
	);
});

test("the binary removes the cache directory on --clear", () => {
	const home = mkdtempSync(join(tmpdir(), "netsuite-clear-"));
	mkdirSync(join(home, ".cache", "netsuite-cli", "browser-profile"), { recursive: true });
	mkdirSync(join(home, ".cache", "other-app"), { recursive: true });

	const result = spawnSync(process.execPath, [binary, "--clear"], {
		encoding: "utf8",
		env: isolatedHome(home),
	});

	assert.deepStrictEqual(
		{
			status: result.status,
			stdout: result.stdout,
			removedTheCache: existsSync(join(home, ".cache", "netsuite-cli")),
			keptTheOtherApp: existsSync(join(home, ".cache", "other-app")),
		},
		{
			status: 0,
			stdout: `Removed ${join(home, ".cache", "netsuite-cli")} and its contents (browser profile, cached session, login cookies and login page)\n`,
			removedTheCache: false,
			keptTheOtherApp: true,
		},
	);
});

test("the binary prints the removal as JSON with --clear --json", () => {
	const home = mkdtempSync(join(tmpdir(), "netsuite-clear-"));
	mkdirSync(join(home, ".cache", "netsuite-cli"), { recursive: true });

	const result = spawnSync(process.execPath, [binary, "--clear", "--json"], {
		encoding: "utf8",
		env: isolatedHome(home),
	});

	assert.deepStrictEqual(
		{ status: result.status, printed: JSON.parse(result.stdout) },
		{
			status: 0,
			printed: { removed: true, directory: join(home, ".cache", "netsuite-cli") },
		},
	);
});

test("the binary rejects --clear combined with a command and exits 1", () => {
	const rejected = [];

	for (const argv of [
		["--clear", "projects"],
		["--clear", "projects", "list"],
		["projects", "list", "--clear"],
	]) {
		const result = run(...argv);
		rejected.push({ status: result.status, stdout: result.stdout, stderr: result.stderr });
	}

	assert.deepStrictEqual(rejected, [
		{
			status: 1,
			stdout: "",
			stderr: 'netsuite-cli: "--clear" cannot be combined with a command\n',
		},
		{
			status: 1,
			stdout: "",
			stderr: 'netsuite-cli: "--clear" cannot be combined with a command\n',
		},
		{
			status: 1,
			stdout: "",
			stderr: 'netsuite-cli: "--clear" cannot be combined with a command\n',
		},
	]);
});

test("the binary refuses a --clear typed between the resource and the verb", () => {
	const result = run("projects", "--clear", "list");

	assert.deepStrictEqual(
		{ status: result.status, stdout: result.stdout, stderr: result.stderr },
		{ status: 1, stdout: "", stderr: "netsuite-cli: unknown option '--clear'\n" },
	);
});

test("weekDaysOf turns day names into the dates of the week, defaulting to the working week", async () => {
	assert.deepStrictEqual(
		{
			workingWeek: weekDaysOf("2026-11-09"),
			chosen: weekDaysOf("2026-11-09", "WED, sat"),
		},
		{
			workingWeek: ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"],
			chosen: ["2026-11-11", "2026-11-14"],
		},
	);
	assert.throws(() => weekDaysOf("2026-11-09", "mon,funday"), UsageError);
});

test("the binary runs when it is started through a symlink, as npm and npx do", () => {
	const directory = mkdtempSync(join(tmpdir(), "netsuite-cli-bin-"));
	const link = join(directory, "netsuite-cli");
	symlinkSync(binary, link);
	const result = spawnSync(process.execPath, [link, "--help"], { encoding: "utf8" });

	assert.deepStrictEqual(
		{
			status: result.status,
			printsTheUsage: result.stdout.startsWith("Usage: netsuite-cli"),
		},
		{ status: 0, printsTheUsage: true },
	);
});
