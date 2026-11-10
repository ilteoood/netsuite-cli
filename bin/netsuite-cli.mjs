#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseISO } from "date-fns/parseISO";
import { createAbsence, listAbsences } from "../src/absences.mjs";
import { NetsuiteError, UsageError } from "../src/errors.mjs";
import { resolveActivity, resolveLeaveType } from "../src/labels.mjs";
import { formatJson, formatTable } from "../src/output.mjs";
import { fetchProjectChoices, fetchTasks, resolveChoice } from "../src/projects.mjs";
import { formatHours, weekDates, weekStartOf } from "../src/schedule.mjs";
import { addTimeEntry, fillTimesheet } from "../src/timesheet.mjs";

const GLOBALS = {
	"login-url": { type: "string", value: "<url>", description: "NetSuite login page the browser opens" },
	"cookie-file": { type: "string", value: "<path>", description: "Read the session cookie from a file, no browser" },
	json: { type: "boolean", default: false, description: "Print the result as JSON" },
	clear: {
		type: "boolean",
		default: false,
		description: "Remove the browser profile and the cached session, then exit; it takes no command",
	},
	help: { type: "boolean", default: false, description: "Show this help" },
};

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
			"dry-run": { type: "boolean", default: false, description: "Print the plan and write nothing" },
			force: { type: "boolean", default: false, description: "Write even when the week already has entries" },
			submit: { type: "boolean", default: false, description: "Submit the timesheet after filling it" },
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
};

const globalFlagNames = new Set(Object.keys(GLOBALS).filter((name) => name !== "help"));

const resources = [...new Set(Object.keys(commands).map((key) => key.split(" ")[0]))];
const verbsOf = (resource) =>
	Object.keys(commands)
		.filter((key) => key.startsWith(`${resource} `))
		.map((key) => key.slice(resource.length + 1));

const parseOptions = (flags) =>
	Object.fromEntries(
		Object.entries(flags).map(([name, { type, default: fallback }]) => [
			name,
			fallback === undefined ? { type } : { type, default: fallback },
		]),
	);

const flagLabel = (name, option) => `--${name}${option.type === "string" ? ` ${option.value}` : ""}`;

const splitGlobals = (argv) => {
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith("-")) return [argv.slice(0, index), argv.slice(index)];
		const name = token.split("=")[0].slice(2);
		if (GLOBALS[name]?.type === "string" && !token.includes("=")) index += 1;
	}
	return [argv, []];
};

const parseStrict = (args, options) => {
	try {
		return parseArgs({ args, options, strict: true });
	} catch (error) {
		const unknown = error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? error.message.match(/'(-[^']+)'/)?.[1] : null;
		throw new UsageError(unknown ? `unknown flag "${unknown}"` : error.message);
	}
};

const usageOfFlags = (flags) => {
	const labels = Object.entries(flags).map(([name, option]) => flagLabel(name, option));
	const width = Math.max(...labels.map((label) => label.length));
	return Object.entries(flags).map(([, option], index) => `  ${labels[index].padEnd(width)}  ${option.description}`);
};

const commandLines = (keys) => {
	const width = Math.max(...keys.map((key) => key.length));
	return keys.map((key) => `  ${key.padEnd(width)}  ${commands[key].summary}`);
};

export const usageText = (target) => {
	if (target === null) {
		return [
			"Usage: netsuite-cli [--login-url <url>] [--cookie-file <path>] [--json] <resource> <verb> [flags]",
			"       netsuite-cli --clear",
			"",
			"Commands:",
			...commandLines(Object.keys(commands)),
			"",
			"Global flags, before the resource:",
			...usageOfFlags(GLOBALS),
			"",
			'Run "netsuite-cli <resource> <verb> --help" for the flags of one command.',
			"",
		].join("\n");
	}
	if (commands[target] === undefined) {
		const keys = verbsOf(target).map((verb) => `${target} ${verb}`);
		return [
			`Usage: netsuite-cli ${target} <verb> [flags]`,
			"",
			"Commands:",
			...commandLines(keys),
			"",
			`Run "netsuite-cli ${target} <verb> --help" for the flags of one command.`,
			"",
		].join("\n");
	}
	const { flags, summary } = commands[target];
	const required = Object.entries(flags)
		.filter(([, option]) => option.required)
		.map(([name, option]) => flagLabel(name, option));
	const optional = Object.keys(flags).length > required.length;
	return [
		[`Usage: netsuite-cli ${target}`, ...required, ...(optional ? ["[flags]"] : [])].join(" "),
		"",
		`${summary}.`,
		"",
		...(Object.keys(flags).length === 0 ? [] : ["Flags:", ...usageOfFlags(flags), ""]),
		"Global flags go before the resource: --login-url, --cookie-file, --json.",
		"",
	].join("\n");
};

export const parseCommandLine = (argv) => {
	const [globalArguments, rest] = splitGlobals(argv);
	const { values } = parseStrict(globalArguments, parseOptions(GLOBALS));
	const globals = {
		loginUrl: values["login-url"] ?? null,
		cookieFile: values["cookie-file"] ?? null,
		json: values.json ?? false,
	};
	if (values.help) return { globals, resource: null, verb: null, flags: {}, help: "root" };
	if (values.clear) {
		if (rest.length > 0) throw new UsageError('"--clear" cannot be combined with a command');
		return { globals, clear: true };
	}
	const [resource, ...afterResource] = rest;
	if (resource === undefined) {
		throw new UsageError('missing the resource; run "netsuite-cli --help" for the command list');
	}
	if (!resources.includes(resource)) {
		throw new UsageError(`unknown resource "${resource}"; available: ${resources.join(", ")}`);
	}
	if (afterResource.includes("--help")) {
		const verb = verbsOf(resource).find((name) => name === afterResource[0]) ?? null;
		return { globals, resource, verb, flags: {}, help: verb === null ? resource : `${resource} ${verb}` };
	}
	const misplaced = afterResource
		.map((token) => token.split("=")[0].slice(2))
		.find((name) => globalFlagNames.has(name));
	if (misplaced !== undefined) {
		throw new UsageError(
			misplaced === "clear"
				? '"--clear" cannot be combined with a command'
				: `"--${misplaced}" is a global flag and goes before "${resource}"`,
		);
	}
	const [verb, ...verbArguments] = afterResource;
	if (verb === undefined) {
		throw new UsageError(`missing the verb for "${resource}"; available: ${verbsOf(resource).join(", ")}`);
	}
	const command = commands[`${resource} ${verb}`];
	if (command === undefined) {
		throw new UsageError(`unknown verb "${verb}" for "${resource}"; available: ${verbsOf(resource).join(", ")}`);
	}
	const { values: parsedFlags } = parseStrict(verbArguments, parseOptions(command.flags));
	const flags = { ...parsedFlags };
	for (const [name, option] of Object.entries(command.flags)) {
		if (option.required && flags[name] === undefined) {
			throw new UsageError(`"${resource} ${verb}" needs ${flagLabel(name, option)}`);
		}
	}
	return { globals, resource, verb, flags, help: null };
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

const write = (globals, rows, columns) =>
	process.stdout.write(`${globals.json ? formatJson(rows) : formatTable(rows, columns)}\n`);

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

const writeReport = (globals, report, { dryRun = false } = {}) => {
	if (globals.json) {
		process.stdout.write(`${formatJson(report)}\n`);
		return;
	}
	const counts = `${report.create} created, ${report.replace} replaced, ${report.remove} removed`;
	const total = `${formatHours(report.totalMinutes)} in the week of ${report.weekStart}`;
	const submitted = report.submitted === true ? ", submitted" : "";
	process.stdout.write(`${dryRun ? "Plan:" : "Wrote"} ${counts}, ${total}${submitted}\n`);
};

const handlers = {
	"projects list": async ({ client, globals }) => {
		const { projects } = await fetchProjectChoices(client, weekStartOf());
		write(globals, projects, PROJECT_COLUMNS);
	},
	"vacations list": async ({ client, globals }) => {
		write(globals, await listAbsences(client), VACATION_COLUMNS);
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
			dryRun: flags["dry-run"],
			force: flags.force,
			submit: flags.submit,
		});
		writeReport(globals, report, { dryRun: flags["dry-run"] });
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
		process.stdout.write(
			globals.json ? `${formatJson(created)}\n` : `Created ${created.reference} (id ${created.id})\n`,
		);
	},
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
		const command = parseCommandLine(argv);
		if (command.clear) {
			const { clearCache } = await import("../src/session.mjs");
			const { removed, directory } = await clearCache();
			const summary = removed
				? `Removed ${directory} (browser profile and cached session)`
				: `Nothing to remove in ${directory}`;
			process.stdout.write(command.globals.json ? `${formatJson({ removed, directory })}\n` : `${summary}\n`);
			return 0;
		}
		if (command.help !== null) {
			process.stdout.write(usageText(command.help === "root" ? null : command.help));
			return 0;
		}
		const handler = handlers[`${command.resource} ${command.verb}`];
		if (handler === undefined) {
			throw new UsageError(`"${command.resource} ${command.verb}" is not implemented yet`);
		}
		const { createClient } = await import("../src/client.mjs");
		const client = await createClient(command.globals);
		return (await handler({ client, globals: command.globals, flags: command.flags })) ?? 0;
	} catch (error) {
		const { exitCode, message } = errorReport(error);
		process.stderr.write(`netsuite-cli: ${message}\n`);
		return exitCode;
	}
};

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exitCode = await main(process.argv.slice(2));
}
