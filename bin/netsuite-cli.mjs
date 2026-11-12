#!/usr/bin/env node
import { Command, CommanderError, Option } from "commander";
import { parseISO } from "date-fns/parseISO";
import { createAbsence, listAbsences } from "../src/absences.mjs";
import { clearCache, SESSION_CACHE_PATH } from "../src/cache.mjs";
import { NetsuiteError, UsageError } from "../src/errors.mjs";
import { resolveActivity, resolveLeaveType } from "../src/labels.mjs";
import { formatJson, formatTable } from "../src/output.mjs";
import { exportProfile, importProfile } from "../src/profile.mjs";
import { fetchProjectChoices, fetchTasks, resolveChoice } from "../src/projects.mjs";
import { formatHours, weekDates, weekStartOf } from "../src/schedule.mjs";
import { isNetsuiteLoginUrl, loginThroughBrowser, storedLoginUrl } from "../src/session.mjs";
import { addTimeEntry, fillTimesheet, listTimesheet } from "../src/timesheet.mjs";

const commands = {
	"projects list": {
		summary: "List the projects available for the timesheet",
		flags: {},
	},
	"vacations list": {
		summary: "List the upcoming vacations",
		flags: {},
	},
	"vacations create": {
		summary: "Create a vacation request",
		flags: {
			start: { type: "string", value: "<date>", required: true, description: "First day, YYYY-MM-DD" },
			end: { type: "string", value: "<date>", description: "Last day, YYYY-MM-DD (default: --start)" },
			type: { type: "string", value: "<name>", required: true, description: "Leave type, e.g. Annual Leave" },
			memo: { type: "string", value: "<text>", description: "Memo" },
			reference: { type: "string", value: "<text>", description: "Reference (default: type and dates)" },
		},
	},
	"timesheet list": {
		summary: "List the entries of one week of the timesheet",
		flags: {
			week: { type: "string", value: "<date>", description: "Monday of the week (default: current week)" },
		},
	},
	"timesheet fill": {
		summary: "Fill a week of the timesheet with one project",
		flags: {
			week: { type: "string", value: "<date>", description: "Monday of the week (default: current week)" },
			project: { type: "string", value: "<name>", required: true, description: "Project name" },
			task: { type: "string", value: "<name>", required: true, description: "Task name" },
			hours: { type: "string", value: "<hours>", required: true, description: "Hours per day, decimal or H:MM" },
			days: { type: "string", value: "<days>", description: "Days to fill (default: mon,tue,wed,thu,fri)" },
			activity: {
				type: "string",
				value: "<name>",
				description: "Activity label or id (default: Solution Delivery)",
			},
			memo: { type: "string", value: "<text>", description: "Memo (default: the task name)" },
			"dry-run": { type: "boolean", description: "Print the plan and write nothing" },
			force: { type: "boolean", description: "Write even when the week already has entries" },
			submit: { type: "boolean", description: "Submit the timesheet after filling it" },
		},
	},
	"timesheet add": {
		summary: "Add one row to the timesheet of a date",
		flags: {
			date: { type: "string", value: "<date>", required: true, description: "Day of the row, YYYY-MM-DD" },
			project: { type: "string", value: "<name>", required: true, description: "Project name" },
			task: { type: "string", value: "<name>", required: true, description: "Task name" },
			hours: { type: "string", value: "<hours>", required: true, description: "Hours, decimal or H:MM" },
			activity: {
				type: "string",
				value: "<name>",
				description: "Activity label or id (default: Solution Delivery)",
			},
			memo: { type: "string", value: "<text>", description: "Memo (default: the task name)" },
		},
	},
	"profile export": {
		summary: "Export the login browser profile, the cached session and the login cookies to an archive",
		argument: { name: "path", value: "<path>" },
		flags: {},
	},
	"profile import": {
		summary: "Import a browser profile archive exported by this CLI",
		argument: { name: "path", value: "<path>" },
		flags: {
			force: { type: "boolean", description: "Replace the browser profile already on this machine" },
		},
	},
};

const resourceSummaries = {
	projects: "Projects available for the timesheet",
	vacations: "Absences and leave types",
	timesheet: "Timesheet entries",
	profile: "Login browser profile",
};

const CLEAR_ALONE_MESSAGE = '"--clear" cannot be combined with a command';

const flagLabel = (name, option) => `--${name}${option.type === "string" ? ` ${option.value}` : ""}`;

const sessionGlobals = (options) => ({
	cookieFile: options.cookieFile ?? null,
	json: options.json ?? false,
});

export const buildProgram = (dispatch) => {
	const program = new Command();
	program
		.hook("preSubcommand", () => {
			if (program.opts().clear === true) throw new UsageError(CLEAR_ALONE_MESSAGE);
		})
		.name("netsuite-cli")
		.description("NetSuite timesheet, project and vacation records of the signed-in employee")
		.enablePositionalOptions()
		.exitOverride()
		.configureOutput({
			outputError: (message, write) => write(message.replace(/^error: /, "netsuite-cli: ")),
		})
		.option("--cookie-file <path>", "Read the session cookie from a file, no browser")
		.option("--json", "Print the result as JSON")
		.option(
			"--clear",
			"Remove the browser profile, the cached session, the login cookies and the stored login page, then exit",
		)
		.addHelpText(
			"after",
			[
				"",
				"Usage: netsuite-cli <resource> <verb> [flags]",
				"       netsuite-cli login [url]",
				"       netsuite-cli --clear",
				"",
			].join("\n"),
		)
		.action((options) => {
			const [resource] = program.args;
			if (resource !== undefined) {
				const available = program.commands.map((entry) => entry.name()).join(", ");
				throw new UsageError(`unknown resource "${resource}"; available: ${available}`);
			}
			if (options.clear !== true) {
				throw new UsageError('missing the resource; run "netsuite-cli --help" for the command list');
			}
			const { removed, directory } = clearCache();
			const summary = removed
				? `Removed ${directory} and its contents (browser profile, cached session, login cookies and login page)`
				: `Nothing to remove in ${directory}`;
			const globals = sessionGlobals(options);
			emit(globals, { removed, directory }, () => summary);
			return 0;
		});

	program
		.command("login [url]")
		.description("Store the NetSuite sign-in page and sign in through the browser")
		.addHelpText(
			"after",
			'\nThe URL is required the first time and after "--clear"; later runs reuse the stored one.\n',
		)
		.action((url) => dispatch({ key: "login", flags: { url: url ?? null }, globals: sessionGlobals(program.opts()) }));

	const globalFlags = program.options.map((option) => option.long).filter((flag) => flag !== "--clear");

	for (const [key, command] of Object.entries(commands)) {
		const [resource, verb] = key.split(" ");
		const resourceCommand =
			program.commands.find((entry) => entry.name() === resource) ??
			program.command(resource).description(resourceSummaries[resource]);
		const leaf = resourceCommand.command(verb).description(command.summary);
		for (const [name, option] of Object.entries(command.flags)) {
			const label = flagLabel(name, option);
			if (option.required) leaf.requiredOption(label, option.description);
			else leaf.option(label, option.description, option.default);
		}
		const required = Object.entries(command.flags)
			.filter(([, option]) => option.required)
			.map(([name, option]) => flagLabel(name, option));
		if (required.length > 0) leaf.usage(`${required.join(" ")} [options]`);
		leaf.addOption(new Option("--clear").hideHelp());
		leaf.addHelpText("after", `\nGlobal flags go before the resource: ${globalFlags.join(", ")}.\n`);
		const run = (options, values) => {
			if (program.opts().clear === true || options.clear === true) {
				throw new UsageError(CLEAR_ALONE_MESSAGE);
			}
			return dispatch({ key, flags: { ...options, ...values }, globals: sessionGlobals(program.opts()) });
		};
		if (command.argument === undefined) {
			leaf.action((options) => run(options, {}));
		} else {
			leaf
				.argument(command.argument.value)
				.action((value, options) => run(options, { [command.argument.name]: value }));
		}
	}

	program.allowExcessArguments(true);

	return program;
};

const PROJECT_COLUMNS = [
	{ header: "Project", value: (project) => project.name },
	{ header: "Id", value: (project) => project.id },
];

const VACATION_COLUMNS = [
	{ header: "Type", value: (vacation) => vacation.typeLabel },
	{ header: "Start", value: (vacation) => vacation.startDate },
	{ header: "End", value: (vacation) => vacation.endDate },
	{ header: "Status", value: (vacation) => vacation.statusLabel },
	{ header: "Days", value: (vacation) => vacation.days },
	{ header: "Id", value: (vacation) => vacation.id },
];

const TIMESHEET_COLUMNS = [
	{ header: "Date", value: (entry) => entry.date },
	{ header: "Project", value: (entry) => entry.projectName },
	{ header: "Task", value: (entry) => entry.taskName },
	{ header: "Hours", value: (entry) => entry.hours },
	{ header: "Memo", value: (entry) => entry.memo },
];

const emit = (globals, value, render) => process.stdout.write(`${globals.json ? formatJson(value) : render(value)}\n`);

const write = (globals, rows, columns) => emit(globals, rows, (rows) => formatTable(rows, columns));

const weekLine = ({ totalMinutes, weekStart, submitted }) =>
	`${formatHours(totalMinutes)} in the week of ${weekStart}${submitted === true ? ", submitted" : ""}`;

const writeWeek = (globals, week, columns) =>
	emit(globals, week, (week) => `${formatTable(week.entries, columns)}\n${weekLine(week)}`);

const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export const weekDaysOf = (weekStart, value) => {
	const names = (value ?? "mon,tue,wed,thu,fri").split(",").map((name) => name.trim().toLowerCase());
	const indexes = names.map((name) => {
		const index = DAY_NAMES.indexOf(name.slice(0, 3));
		if (index === -1) throw new UsageError(`--days takes day names such as mon,tue, not "${name}"`);
		return index;
	});
	return weekDates(weekStart).filter((_, index) => indexes.includes(index));
};

const isoDate = (flagName, value) => {
	if (value === undefined || /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
	throw new UsageError(`--${flagName} takes a date as YYYY-MM-DD, not "${value}"`);
};

const resolveProjectAndTask = async (client, weekStart, flags) => {
	const { employeeId, projects } = await fetchProjectChoices(client, weekStart);
	const project = resolveChoice(projects, flags.project, "project");
	const tasks = await fetchTasks(client, { weekStart, employeeId });
	const projectTasks = tasks.filter((task) => task.projectId === project.id);
	return { project, task: resolveChoice(projectTasks, flags.task, "task") };
};

const writeReport = (globals, report, { dryRun = false } = {}) =>
	emit(globals, report, (report) => {
		const counts = `${report.create} created, ${report.replace} replaced, ${report.remove} removed`;
		return `${dryRun ? "Plan:" : "Wrote"} ${counts}, ${weekLine(report)}`;
	});

export const handlers = {
	login: async ({ globals, flags, signIn = loginThroughBrowser }) => {
		if (globals.cookieFile !== null) {
			throw new UsageError('"login" signs in through the browser, so it cannot be combined with "--cookie-file"');
		}
		const loginUrl = flags.url === null ? storedLoginUrl() : flags.url;
		if (loginUrl === null) {
			throw new UsageError('login has no stored sign-in page yet; pass it: "netsuite-cli login <url>"');
		}
		if (!isNetsuiteLoginUrl(loginUrl)) {
			throw new UsageError(`login takes the NetSuite sign-in page as an https URL, not "${loginUrl}"`);
		}
		const { account } = await signIn({ loginUrl, headless: false });
		emit(globals, { account }, () => `Signed in to ${account} (session cached in ${SESSION_CACHE_PATH})`);
	},
	"projects list": async ({ client, globals }) => {
		const { projects } = await fetchProjectChoices(client, weekStartOf());
		write(globals, projects, PROJECT_COLUMNS);
	},
	"vacations list": async ({ client, globals }) => {
		write(globals, await listAbsences(client), VACATION_COLUMNS);
	},
	"timesheet list": async ({ client, globals, flags }) => {
		const weekStart = isoDate("week", flags.week) ?? weekStartOf();
		writeWeek(globals, await listTimesheet(client, weekStart), TIMESHEET_COLUMNS);
	},
	"timesheet fill": async ({ client, globals, flags }) => {
		const weekStart = isoDate("week", flags.week) ?? weekStartOf();
		const { project, task } = await resolveProjectAndTask(client, weekStart, flags);
		const report = await fillTimesheet(client, {
			weekStart,
			project,
			task,
			hours: flags.hours,
			days: weekDaysOf(weekStart, flags.days),
			activityId: resolveActivity(flags.activity ?? "71").id,
			memo: flags.memo ?? task.name,
			dryRun: flags.dryRun,
			force: flags.force,
			submit: flags.submit,
		});
		writeReport(globals, report, { dryRun: flags.dryRun });
	},
	"timesheet add": async ({ client, globals, flags }) => {
		const date = isoDate("date", flags.date);
		const weekStart = weekStartOf(parseISO(date));
		const { project, task } = await resolveProjectAndTask(client, weekStart, flags);
		const report = await addTimeEntry(client, {
			date,
			project,
			task,
			hours: flags.hours,
			activityId: resolveActivity(flags.activity ?? "71").id,
			memo: flags.memo ?? task.name,
		});
		writeReport(globals, report);
	},
	"vacations create": async ({ client, globals, flags }) => {
		const type = resolveLeaveType(flags.type);
		const created = await createAbsence(client, {
			typeId: type.id,
			typeLabel: type.name,
			startDate: isoDate("start", flags.start),
			endDate: isoDate("end", flags.end),
			memo: flags.memo ?? "",
			reference: flags.reference,
		});
		emit(globals, created, () => `Created ${created.reference} (id ${created.id})`);
	},
	"profile export": async ({ globals, flags }) => {
		const { archive, bytes } = await exportProfile({ archivePath: flags.path });
		emit(globals, { archive, bytes }, () => `Exported the browser profile to ${archive} (${bytes} bytes)`);
	},
	"profile import": async ({ globals, flags }) => {
		const { archive, profile, session, loginCookies } = await importProfile({
			archivePath: flags.path,
			force: flags.force,
		});
		const restored = [session === true && "the cached session", loginCookies === true && "the login cookies"].filter(
			Boolean,
		);
		const restoredNote = restored.length === 0 ? "" : ` and ${restored.join(" and ")}`;
		emit(
			globals,
			{ archive, profile, session, loginCookies },
			() => `Imported the browser profile into ${profile}${restoredNote}`,
		);
	},
};

const SESSION_FREE_COMMANDS = new Set(["login", "profile export", "profile import"]);

const runCommand = async ({ key, flags, globals }) => {
	const handler = handlers[key];
	if (handler === undefined) {
		throw new UsageError(`"${key}" is not implemented yet`);
	}
	if (SESSION_FREE_COMMANDS.has(key)) return (await handler({ globals, flags })) ?? 0;
	const { createClient } = await import("../src/client.mjs");
	const client = await createClient(globals);
	return (await handler({ client, globals, flags })) ?? 0;
};

export const errorReport = (error) => {
	if (error instanceof UsageError) return { exitCode: 1, message: error.message };
	const message =
		error instanceof NetsuiteError && error.detail
			? `${error.message}: ${error.detail}`
			: error instanceof Error
				? error.message
				: String(error);
	return { exitCode: 2, message };
};

export const main = async (argv) => {
	try {
		const program = buildProgram(runCommand);
		await program.parseAsync(argv, { from: "user" });
		return 0;
	} catch (error) {
		if (error instanceof CommanderError) return error.exitCode;
		const { exitCode, message } = errorReport(error);
		process.stderr.write(`netsuite-cli: ${message}\n`);
		return exitCode;
	}
};

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
